import type { Env } from "../types";
import { feedStatement } from "../db/feed";
import { enqueueStatement } from "../telegram/outbox";
import { newsFingerprint } from "./dedupe";
import { fetchWithTimeout } from "../utils/http";
import { escapeTelegramHtml, normalizeUrl, nowIso, sha256 } from "../utils/text";
import { findTickers, isRelevantNews, isTurkishNews } from "./filter";
import { parseRss } from "./parser";
import { RSS_SOURCES } from "./sources";

function publishedWithin24Hours(value: string | null): boolean {
  if (!value) return true;
  const time = Date.parse(value);
  return Number.isNaN(time) || time >= Date.now() - 24 * 60 * 60 * 1000;
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
  const xml = await response.text();
  const parsed = parseRss(xml);
  if (!parsed.length && !/<(?:rss|feed)\b/i.test(xml)) throw new Error(`${source.name}: response was not an RSS feed`);
  const items = parsed.filter(item =>
    publishedWithin24Hours(item.publishedAt) &&
    isTurkishNews(item.title, item.description ?? "") &&
    isRelevantNews(item.title, item.description ?? "")
  );
  let inserted = 0;
  for (const item of items) {
    const normalizedUrl = normalizeUrl(item.url);
    const summary = item.description?.replace(/\s+/g, ' ').trim().slice(0,700) ?? '';
    const identity = {title:item.title, summary};
    const fingerprint = newsFingerprint(identity);
    const hash = await sha256(fingerprint);
    // content_hash is UNIQUE, so this point lookup provides the same
    // cross-source fingerprint deduplication without rescanning the whole
    // 24-hour comparison window for every RSS source every minute.
    if (await env.DB.prepare("SELECT content_hash FROM rss_items WHERE content_hash=?").bind(hash).first()) continue;
    const existing = await env.DB.prepare("SELECT content_hash FROM rss_items WHERE normalized_url=?").bind(normalizedUrl).first();
    const tickers = findTickers(item.title, item.description ?? "");
    const seen = nowIso();
    const ref = `rss:${hash}`;
    const hashtagLine = tickers.length ? tickers.map(code => `#${code}`).join(" ")+"\n" : "";
    const text = `${hashtagLine}📰 <b>${escapeTelegramHtml(source.name)}</b>\n\n<b>${escapeTelegramHtml(item.title)}</b>${summary && summary !== item.title ? "\n\n"+escapeTelegramHtml(summary) : ""}`;
    const statements = [
      env.DB.prepare(`INSERT OR IGNORE INTO rss_items(source,title,url,normalized_url,published_at,fetched_at,content_hash,tickers_json,telegram_status)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(source.name,item.title,item.url,existing ? `${normalizedUrl}#revision=${hash}` : normalizedUrl,item.publishedAt,seen,hash,JSON.stringify(tickers),initialSeed ? "baseline":"pending"),
      feedStatement(env,{type:"news",source:source.name,source_ref:ref,title:item.title,body:summary || null,url:item.url,tickers_json:JSON.stringify(tickers),published_at:item.publishedAt}),
    ];
    if (!initialSeed) statements.push(enqueueStatement(env,ref,"message",{text,button:{text:"🔗 Haberi Aç",url:item.url}},item.publishedAt,seen));
    await env.DB.batch(statements);
    inserted++;
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
