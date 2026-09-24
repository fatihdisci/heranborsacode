import type { Env, FeedItem } from "../types";

export async function insertFeed(env: Env, item: Omit<FeedItem, "id" | "created_at">): Promise<void> {
  await feedStatement(env, item).run();
}

export function feedStatement(env: Env, item: Omit<FeedItem, "id" | "created_at">): D1PreparedStatement {
  return env.DB.prepare(`INSERT OR IGNORE INTO feed_items(type, source, source_ref, title, body, url, tickers_json, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(item.type, item.source, item.source_ref, item.title, item.body, item.url, item.tickers_json, item.published_at);
}

export interface FeedCursor { time: string; id: number; }

export async function listFeed(env: Env, filters: { category?: import('../sources/registry').Category;  q?: string; source?: string; cursor?: FeedCursor; limit: number }): Promise<{ items: FeedItem[]; nextCursor: string | null }> {
  const timeline = "COALESCE(published_at, created_at)";
  const conditions: string[] = ["category IS NOT NULL"];
  const values: unknown[] = [];
  if (filters.cursor) {
    conditions.push(`(${timeline} < ? OR (${timeline} = ? AND id < ?))`);
    values.push(filters.cursor.time, filters.cursor.time, filters.cursor.id);
  }
  if (filters.category) { conditions.push("category = ?"); values.push(filters.category); }
  if (filters.source) { conditions.push("source = ?"); values.push(filters.source); }

  if (filters.q) { conditions.push("(title LIKE ? OR body LIKE ?)"); values.push(`%${filters.q}%`, `%${filters.q}%`); }
  values.push(filters.limit + 1);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DB.prepare(`SELECT * FROM feed_items ${where} ORDER BY ${timeline} DESC, id DESC LIMIT ?`).bind(...values).all<FeedItem>();
  const rows = result.results ?? [];
  const hasMore = rows.length > filters.limit;
  const items = rows.slice(0, filters.limit);
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? `${last.published_at ?? last.created_at}|${last.id}` : null };
}
