import type { Env, FeedType } from "../types";
import { listFeed } from "../db/feed";
import { json } from "../utils/http";
import { generateTweetDraft } from "../ai/tweet";
import { authorizeTelegramRequest } from "../security/telegram";

const TYPES = new Set<FeedType>(["kap", "spk", "news"]);

export async function api(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      const cron = await env.DB.prepare("SELECT key,value FROM system_state WHERE key IN ('cron_last_started_at','cron_last_finished_at')").all<{ key: string; value: string }>();
      const cronState = Object.fromEntries((cron.results ?? []).map(row => [row.key, row.value]));
      const shards = await env.DB.prepare("SELECT key,value FROM system_state WHERE key LIKE 'poll_shard:%' ORDER BY key").all<{ key: string; value: string }>();
      const shardState = Object.fromEntries((shards.results ?? []).map(row => {
        try { return [row.key.slice("poll_shard:".length), JSON.parse(row.value)]; }
        catch { return [row.key.slice("poll_shard:".length), { error: "invalid_state" }]; }
      }));
      return json({ ok: true, service: "heranborsa", database: "connected", cron: { lastStartedAt: cronState.cron_last_started_at ?? null, lastFinishedAt: cronState.cron_last_finished_at ?? null }, shards: shardState, timestamp: new Date().toISOString() });
    } catch {
      return json({ ok: false, service: "heranborsa", database: "unavailable" }, 503);
    }
  }
  if (url.pathname === "/api/sources" && request.method === "GET") {
    const sources = await env.DB.prepare("SELECT DISTINCT source FROM feed_items ORDER BY source COLLATE NOCASE").all<{ source: string }>();
    return json({ sources: (sources.results ?? []).map(row => row.source) }, 200, { "cache-control": "public, max-age=60" });
  }
  if (url.pathname === "/api/tweet-draft") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    if (!await authorizeTelegramRequest(request, env)) return json({ error: "unauthorized" }, 401);
    if (!env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 503);
    let feedItemId: number;
    try {
      const body = await request.json<{ feedItemId?: unknown }>();
      feedItemId = Number(body.feedItemId);
    } catch { return json({ error: "invalid_json" }, 400); }
    if (!Number.isSafeInteger(feedItemId) || feedItemId < 1) return json({ error: "invalid_feed_item" }, 400);
    const item = await env.DB.prepare("SELECT * FROM feed_items WHERE id=?").bind(feedItemId).first<import("../types").FeedItem>();
    if (!item) return json({ error: "not_found" }, 404);
    try {
      const draft = await generateTweetDraft(env, item);
      return json(draft);
    } catch (error) {
      console.error("AI tweet generation failed", { feedItemId, error: error instanceof Error ? error.message : String(error) });
      return json({ error: "tweet_generation_failed" }, 502);
    }
  }
  if (url.pathname !== "/api/feed") return null;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
  const requestedType = url.searchParams.get("type");
  if (requestedType && !TYPES.has(requestedType as FeedType)) return json({ error: "invalid_type" }, 400);
  const rawLimit = Number(url.searchParams.get("limit") ?? "30");
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 30;
  const rawCursor = url.searchParams.get("cursor");
  const cursorParts = rawCursor?.split("|");
  const cursor = cursorParts?.length === 2 && !Number.isNaN(Date.parse(cursorParts[0])) && /^\d+$/.test(cursorParts[1]) ? { time: cursorParts[0], id: Number(cursorParts[1]) } : undefined;
  const ticker = url.searchParams.get("ticker")?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || undefined;
  const q = url.searchParams.get("q")?.trim().slice(0, 120) || undefined;
  const source = url.searchParams.get("source")?.trim().slice(0, 100) || undefined;
  const result = await listFeed(env, { type: requestedType as FeedType | undefined, ticker, q, source, cursor, limit });
  return json(result, 200, { "cache-control": "public, max-age=15" });
}
