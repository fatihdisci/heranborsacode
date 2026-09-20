import type { Env } from "../types";
import { insertFeed } from "../db/feed";
import { sendMessage } from "../telegram/client";
import { fetchWithTimeout } from "../utils/http";
import { escapeTelegramHtml, normalizeTitle, normalizeUrl, nowIso, sha256 } from "../utils/text";
import { findTickers, isRelevantNews, isTurkishNews } from "./filter";
import { parseRss } from "./parser";
import { RSS_SOURCES } from "./sources";

function titleWords(value: string): Set<string> {
  return new Set(normalizeTitle(value).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2));
}

function similarTitleWords(left: Set<string>, right: Set<string>): boolean {
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

async function deliverPending(env: Env, hash: string | null = null, source: string | null = null): Promise<void> {
  const pending = await env.DB.prepare(`SELECT r.content_hash, r.source, r.title, r.url, r.tickers_json, f.body
    FROM rss_items r JOIN feed_items f ON f.source_ref = 'rss:' || r.content_hash
    WHERE r.telegram_status = 'pending'
      AND datetime(COALESCE(r.published_at,r.fetched_at)) >= datetime('now', '-1 day')
      AND (? IS NULL OR r.content_hash = ?)
      AND (? IS NULL OR r.source = ?)
    ORDER BY datetime(r.published_at) DESC, r.id DESC`).bind(hash, hash, source, source).all<{ content_hash: string; source: string; title: string; url: string; tickers_json: string | null; body: string | null }>();
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

async function pollSource(env: Env, source: { name: string; url: string }): Promise<number> {
  const sourceInitialized = await env.DB.prepare("SELECT value FROM system_state WHERE key = ?").bind(`rss_baseline:${source.url}`).first();
  const initialSeed = !sourceInitialized;
  const headers = new Headers({ "user-agent": "HeranBorsa/0.1 (+Cloudflare Worker)", accept: "application/rss+xml, application/xml, text/xml", "cache-control": "no-cache", pragma: "no-cache" });
  // Read the full feed every minute, bypassing Worker cache and potentially
  // stale publisher validators. Item IDs provide our deduplication.
  const response = await fetchWithTimeout(source.url, { headers, cache: "no-store" });
  if (response.status === 304) {
    await env.DB.prepare("UPDATE feed_sources SET last_success_at=CURRENT_TIMESTAMP,last_error=NULL WHERE url=?").bind(source.url).run();
    return 0;
  }
  if (!response.ok) throw new Error(`${source.name} RSS HTTP ${response.status}`);
  // Every provider must pass the same Turkish finance/BIST filter. This keeps
  // lifestyle/general-news items and English wire copy out of both the Mini
  // App and Telegram notifications.
  const items = parseRss(await response.text()).filter(item =>
    publishedWithin24Hours(item.publishedAt) &&
    isTurkishNews(item.title, item.description ?? "") &&
    isRelevantNews(item.title, item.description ?? "")
  );
  let inserted = 0;
  // Read the comparison window once per source. Previously this query ran for
  // every item in every feed and was the largest avoidable part of cron CPU.
  const recent = await env.DB.prepare("SELECT title FROM rss_items WHERE published_at >= datetime('now', '-1 day') LIMIT 250").all<{ title: string }>();
  const recentWordSets = (recent.results ?? []).map(row => titleWords(row.title));
  for (const item of items) {
    const normalizedUrl = normalizeUrl(item.url);
    // URL is the first dedupe key (unique normalized_url); the title hash is
    // deliberately independent of publisher URL to collapse syndicated copies.
    const hash = await sha256(normalizeTitle(item.title));
    const tickers = findTickers(item.title, item.description ?? "");
    const itemWordSet = titleWords(item.title);
    if (recentWordSets.some(words => similarTitleWords(itemWordSet, words))) continue;
    const write = await env.DB.prepare(`INSERT OR IGNORE INTO rss_items(source, title, url, normalized_url, published_at, fetched_at, content_hash, tickers_json, telegram_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(source.name, item.title, item.url, normalizedUrl, item.publishedAt, nowIso(), hash, JSON.stringify(tickers), initialSeed ? "baseline" : "pending").run();
    if (!write.meta.changes) continue;
    inserted++;
    recentWordSets.push(itemWordSet);
    const summary = item.description?.replace(/\s+/g, " ").trim().slice(0, 700) || null;
    await insertFeed(env, { type: "news", source: source.name, source_ref: `rss:${hash}`, title: item.title, body: summary, url: item.url, tickers_json: JSON.stringify(tickers), published_at: item.publishedAt });
    if (!initialSeed) await deliverPending(env, hash);
  }
  await env.DB.prepare(`INSERT INTO feed_sources(url, name, etag, last_modified, last_success_at, last_error) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(url) DO UPDATE SET name = excluded.name, etag = excluded.etag, last_modified = excluded.last_modified, last_success_at = CURRENT_TIMESTAMP, last_error = NULL`)
    .bind(source.url, source.name, response.headers.get("etag"), response.headers.get("last-modified")).run();
  await env.DB.prepare("INSERT OR IGNORE INTO system_state(key, value) VALUES (?, '1')").bind(`rss_baseline:${source.url}`).run();
  return inserted;
}

export async function pollRSSSource(env: Env, source: { name: string; url: string }): Promise<void> {
  try {
    await pollSource(env, source);
    await deliverPending(env, null, source.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("rss source failed", { source: source.name, error: message });
    await env.DB.prepare(`INSERT INTO feed_sources(url, name, last_error) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET last_error = excluded.last_error`).bind(source.url, source.name, message.slice(0, 400)).run();
    throw error;
  }
}

export async function pollRSS(env: Env): Promise<void> {
  await Promise.allSettled(RSS_SOURCES.map(source => pollRSSSource(env, source)));
}
