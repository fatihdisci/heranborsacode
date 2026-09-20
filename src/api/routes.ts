import type { Env, FeedType } from "../types";
import { listFeed } from "../db/feed";
import { json } from "../utils/http";

const TYPES = new Set<FeedType>(["kap", "spk", "news"]);

export async function api(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return json({ ok: true, service: "heranborsa", database: "connected", timestamp: new Date().toISOString() });
    } catch {
      return json({ ok: false, service: "heranborsa", database: "unavailable" }, 503);
    }
  }
  if (url.pathname === "/api/sources" && request.method === "GET") {
    const sources = await env.DB.prepare("SELECT DISTINCT source FROM feed_items ORDER BY source COLLATE NOCASE").all<{ source: string }>();
    return json({ sources: (sources.results ?? []).map(row => row.source) }, 200, { "cache-control": "public, max-age=60" });
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
