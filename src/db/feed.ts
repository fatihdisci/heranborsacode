import type { Env, FeedItem, FeedType } from "../types";

export async function insertFeed(env: Env, item: Omit<FeedItem, "id" | "created_at">): Promise<void> {
  await feedStatement(env, item).run();
}

export function feedStatement(env: Env, item: Omit<FeedItem, "id" | "created_at">): D1PreparedStatement {
  return env.DB.prepare(`INSERT OR IGNORE INTO feed_items(type, source, source_ref, title, body, url, tickers_json, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(item.type, item.source, item.source_ref, item.title, item.body, item.url, item.tickers_json, item.published_at);
}

export interface FeedCursor { time: string; id: number; }

// Older KAP rows kept every related share in tickers_json. Index and watch
// filters need the actual disclosure subject, including for historical rows.
export const subjectTickersSql = `CASE
  WHEN f.type!='kap' THEN f.tickers_json
  WHEN json_valid(k.metadata_json) AND json_type(k.metadata_json,'$.subjectCodes')='array'
    THEN json_extract(k.metadata_json,'$.subjectCodes')
  WHEN f.title LIKE '%Devre Kes%' THEN f.tickers_json
  WHEN json_valid(f.tickers_json) AND json_array_length(f.tickers_json)=1 THEN f.tickers_json
  ELSE '[]' END`;
export const feedJoinSql = "LEFT JOIN kap_disclosures k ON f.type='kap' AND k.disclosure_id=substr(f.source_ref,5)";

export async function listFeed(env: Env, filters: { type?: FeedType; ticker?: string; q?: string; source?: string; tickerList?: string[]; cursor?: FeedCursor; limit: number }): Promise<{ items: FeedItem[]; nextCursor: string | null }> {
  // Press releases expose only a calendar date. Show a newly detected release
  // at its first-seen position instead of burying it at midnight.
  const timeline = "CASE WHEN f.source_ref LIKE 'spk:press:%' THEN strftime('%Y-%m-%dT%H:%M:%fZ',f.created_at) ELSE COALESCE(f.published_at, f.created_at) END";
  // Migration 0016 keeps AI Radar rows for history. Only pre-transition
  // finance rows (and new finance inserts, which leave category NULL) belong
  // in the Heran Borsa feed.
  const conditions: string[] = ["f.category IS NULL", "f.type IN ('kap','spk','news')"];
  const values: unknown[] = [];
  if (filters.cursor) {
    conditions.push(`(${timeline} < ? OR (${timeline} = ? AND f.id < ?))`);
    values.push(filters.cursor.time, filters.cursor.time, filters.cursor.id);
  }
  if (filters.tickerList) {
    if (!filters.tickerList.length) conditions.push('0=1');
    else { conditions.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${subjectTickersSql}) THEN ${subjectTickersSql} ELSE '[]' END) t WHERE t.value IN (${filters.tickerList.map(()=>'?').join(',')}))`);values.push(...filters.tickerList); }
  }
  if (filters.type) { conditions.push("f.type = ?"); values.push(filters.type); }
  if (filters.source) { conditions.push("f.source = ?"); values.push(filters.source); }
  if (filters.ticker) { conditions.push("f.tickers_json LIKE ?"); values.push(`%\"${filters.ticker.toUpperCase()}\"%`); }
  if (filters.q) { conditions.push("(f.title LIKE ? OR f.body LIKE ?)"); values.push(`%${filters.q}%`, `%${filters.q}%`); }
  values.push(filters.limit + 1);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DB.prepare(`SELECT f.*,${subjectTickersSql} AS subject_tickers_json FROM feed_items f ${feedJoinSql} ${where} ORDER BY ${timeline} DESC, f.id DESC LIMIT ?`).bind(...values).all<FeedItem>();
  const rows = result.results ?? [];
  const hasMore = rows.length > filters.limit;
  const items = rows.slice(0, filters.limit);
  const last = items.at(-1);
  const lastTime=last?.source_ref.startsWith('spk:press:') ? new Date(last.created_at.replace(' ','T')+'Z').toISOString() : last?.published_at ?? last?.created_at;
  return { items, nextCursor: hasMore && last && lastTime ? `${lastTime}|${last.id}` : null };
}
