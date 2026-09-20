import type { Env } from "../types";
import { insertFeed } from "../db/feed";
import { sendMessage } from "../telegram/client";
import { fetchWithTimeout } from "../utils/http";
import { escapeTelegramHtml, normalizeTitle, normalizeUrl, nowIso, sha256 } from "../utils/text";
import { findTickers, isRelevantNews, isTurkishNews } from "./filter";
import { parseRss } from "./parser";
import { RSS_SOURCES } from "./sources";

function similarTitle(a: string, b: string): boolean {
  const words = (value: string) => new Set(normalizeTitle(value).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2));
  const left = words(a), right = words(b);
  if (left.size < 4 || right.size < 4) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.max(left.size, right.size) >= 0.82;
}

function publishedWithin24Hours(value: string | null): boolean {
  if (!value) return true;
  const time = Date.parse(value);
  return Number.isNaN(time) || time >= Date.now() - 24 * 60 * 60 * 1000;
}

async function deliverPending(env: Env): Promise<void> {
  const pending = await env.DB.prepare(`SELECT r.content_hash, r.source, r.title, r.url, r.tickers_json, f.body
    FROM rss_items r JOIN feed_items f ON f.source_ref = 'rss:' || r.content_hash
    WHERE r.telegram_status = 'pending' AND datetime(r.published_at) >= datetime('now', '-1 day')
    ORDER BY r.published_at ASC LIMIT 20`).all<{ content_hash: string; source: string; title: string; url: string; tickers_json: string | null; body: string | null }>();
  for (const item of pending.results ?? []) {
    const tickers = JSON.parse(item.tickers_json ?? "[]") as string[];
    const hashtagLine = tickers.length ? `${tickers.map(ticker => `#${ticker}`).join(" ")}\n` : "";
    const summary = item.body?.replace(/\s+/g, " ").trim().slice(0, 700);
    try {
      await sendMessage(env, `${hashtagLine}📰 <b>${escapeTelegramHtml(item.source)}</b>\n\n<b>${escapeTelegramHtml(item.title)}</b>${summary ? `\n\n${escapeTelegramHtml(summary)}` : ""}`, { text: "🔗 Haberi Aç", url: item.url });
      await env.DB.prepare("UPDATE rss_items SET telegram_status='sent',telegram_sent_at=CURRENT_TIMESTAMP WHERE content_hash=?").bind(item.content_hash).run();
    } catch (error) {
      console.warn("rss pending Telegram delivery failed", { source: item.source, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function pollSource(env: Env, source: { name: string; url: string }, silentBootstrap: boolean): Promise<number> {
  const state = await env.DB.prepare("SELECT etag, last_modified FROM feed_sources WHERE url = ?").bind(source.url).first<{ etag: string | null; last_modified: string | null }>();
  const headers = new Headers({ "user-agent": "HeranBorsa/0.1 (+Cloudflare Worker)", accept: "application/rss+xml, application/xml, text/xml" });
  if (state?.etag) headers.set("if-none-match", state.etag);
  if (state?.last_modified) headers.set("if-modified-since", state.last_modified);
  const response = await fetchWithTimeout(source.url, { headers });
  if (response.status === 304) return 0;
  if (!response.ok) throw new Error(`${source.name} RSS HTTP ${response.status}`);
  // Every provider must pass the same Turkish finance/BIST filter. This keeps
  // lifestyle/general-news items and English wire copy out of both the Mini
  // App and Telegram notifications.
  const items = parseRss(await response.text()).filter(item =>
    publishedWithin24Hours(item.publishedAt) && isTurkishNews(item.title) && isRelevantNews(item.title)
  );
  let inserted = 0;
  for (const item of items) {
    const normalizedUrl = normalizeUrl(item.url);
    // URL is the first dedupe key (unique normalized_url); the title hash is
    // deliberately independent of publisher URL to collapse syndicated copies.
    const hash = await sha256(normalizeTitle(item.title));
    const tickers = findTickers(item.title);
    const recent = await env.DB.prepare("SELECT title FROM rss_items WHERE published_at >= datetime('now', '-1 day') LIMIT 250").all<{ title: string }>();
    if ((recent.results ?? []).some(row => similarTitle(item.title, row.title))) continue;
    const write = await env.DB.prepare(`INSERT OR IGNORE INTO rss_items(source, title, url, normalized_url, published_at, fetched_at, content_hash, tickers_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(source.name, item.title, item.url, normalizedUrl, item.publishedAt, nowIso(), hash, JSON.stringify(tickers)).run();
    if (!write.meta.changes) continue;
    inserted++;
    const summary = item.description?.replace(/\s+/g, " ").trim().slice(0, 700) || null;
    await insertFeed(env, { type: "news", source: source.name, source_ref: `rss:${hash}`, title: item.title, body: summary, url: item.url, tickers_json: JSON.stringify(tickers), published_at: item.publishedAt });
    const sourceInitialized = await env.DB.prepare("SELECT value FROM system_state WHERE key = ?").bind(`rss_baseline:${source.url}`).first();
    if (!sourceInitialized || silentBootstrap) continue;
    try {
      const hashtagLine = tickers.length ? `${tickers.map(ticker => `#${ticker}`).join(" ")}\n` : "";
      const summaryLine = summary ? `\n\n${escapeTelegramHtml(summary)}` : "";
      await sendMessage(env, `${hashtagLine}📰 <b>${escapeTelegramHtml(source.name)}</b>\n\n<b>${escapeTelegramHtml(item.title)}</b>${summaryLine}`, { text: "🔗 Haberi Aç", url: item.url });
      await env.DB.prepare("UPDATE rss_items SET telegram_status = 'sent', telegram_sent_at = CURRENT_TIMESTAMP WHERE content_hash = ?").bind(hash).run();
    } catch (error) {
      console.warn("rss telegram delivery failed", { source: source.name, hash, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await env.DB.prepare(`INSERT INTO feed_sources(url, name, etag, last_modified, last_success_at, last_error) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(url) DO UPDATE SET name = excluded.name, etag = excluded.etag, last_modified = excluded.last_modified, last_success_at = CURRENT_TIMESTAMP, last_error = NULL`)
    .bind(source.url, source.name, response.headers.get("etag"), response.headers.get("last-modified")).run();
  await env.DB.prepare("INSERT OR IGNORE INTO system_state(key, value) VALUES (?, '1')").bind(`rss_baseline:${source.url}`).run();
  return inserted;
}

export async function pollRSS(env: Env): Promise<void> {
  const silentBootstrap = !await env.DB.prepare("SELECT value FROM system_state WHERE key='rss_wide_baseline_initialized'").first();
  await Promise.allSettled(RSS_SOURCES.map(async source => {
    try { await pollSource(env, source, silentBootstrap); }
    catch (error) {
      console.warn("rss source failed", { source: source.name, error: error instanceof Error ? error.message : String(error) });
      await env.DB.prepare(`INSERT INTO feed_sources(url, name, last_error) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET last_error = excluded.last_error`).bind(source.url, source.name, error instanceof Error ? error.message.slice(0, 400) : "unknown error").run();
    }
  }));
  if (silentBootstrap) await env.DB.prepare("INSERT OR IGNORE INTO system_state(key, value) VALUES ('rss_wide_baseline_initialized', '1')").run();
  else await deliverPending(env);
}
