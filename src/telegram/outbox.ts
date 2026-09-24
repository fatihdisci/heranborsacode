import type { Env } from "../types";
import { escapeTelegramHtml, sha256 } from "../utils/text";
import { sendDocument, sendMessage, TelegramError } from "./client";
import type { InlineButton } from './client';
import type { FeedItem } from '../types';
import { feedKeyboard } from './buttons';

export const DKB_WINDOW_MS = 12_000;
export interface DeliveryPayload {
  text?: string;
  plain?: boolean;
  button?: { text: string; url: string };
  document?: { url: string; filename: string };
  codes?: string[];
  keyboard?: InlineButton[][];
  replyTo?: number;
}
interface Job { id: string; source_ref: string | null; kind: string; payload: string; attempts: number; first_seen_at: string; }
function utcTime(value: string): number { return Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z'); }

export function enqueueStatement(env: Env, id: string, kind: string, payload: DeliveryPayload, publishedAt: string | null, firstSeen = new Date().toISOString(), sourceRef: string | null = id): D1PreparedStatement {
  return env.DB.prepare(`INSERT OR IGNORE INTO telegram_outbox
    (id,source_ref,kind,payload,status,first_seen_at,published_at,available_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, sourceRef, kind, JSON.stringify(payload), kind === "dkb" ? "buffered" : "pending", firstSeen, publishedAt, Date.now());
}

export function retryDelay(attempt: number, retryAfter = 0): number {
  return Math.max(retryAfter * 1000, Math.min(300_000, 5000 * 2 ** Math.min(attempt - 1, 6)));
}

export async function flushCircuitBreakers(env: Env, now = Date.now()): Promise<void> {
  const rows = (await env.DB.prepare(`SELECT id,payload,first_seen_at FROM telegram_outbox
    WHERE status='buffered' ORDER BY first_seen_at,id LIMIT 100`).all<Job>()).results ?? [];
  if (!rows.length || now < utcTime(rows[0].first_seen_at) + DKB_WINDOW_MS) return;
  const cutoff = utcTime(rows[0].first_seen_at) + DKB_WINDOW_MS;
  const group = rows.filter(row => utcTime(row.first_seen_at) <= cutoff);
  const codes = [...new Set(group.flatMap(row => (JSON.parse(row.payload) as DeliveryPayload).codes ?? []))];
  const id = `dkb:${await sha256(group.map(row => row.id).join('|'))}`;
  const text = `${codes.map(code => `#${code}`).join(' ')}\n\nDevre kesici uygulandı. Sürekli işleme ara verildi.`;
  // Membership is frozen transactionally. Arrivals during Telegram I/O belong
  // to the next group and can never be marked sent by this group's receipt.
  await env.DB.batch([
    enqueueStatement(env, id, 'dkb_group', { text }, null, group[0].first_seen_at, null),
    ...group.map(row => env.DB.prepare("UPDATE telegram_outbox SET status='grouped',group_id=? WHERE id=? AND status='buffered'").bind(id, row.id)),
  ]);
}

export async function deliverOne(env: Env): Promise<number> {
  const now = Date.now();
  const cooldown = await env.DB.prepare("SELECT value FROM system_state WHERE key='telegram_cooldown_until'").first<{ value: string }>();
  if (Number(cooldown?.value ?? 0) > now) return Math.min(60_000, Number(cooldown!.value) - now);
  const job = await env.DB.prepare(`UPDATE telegram_outbox SET status='sending',lease_until=?,attempts=attempts+1
    WHERE id=(SELECT id FROM telegram_outbox WHERE (status='pending' AND available_at<=?) OR (status='sending' AND lease_until<=?)
      ORDER BY CASE WHEN kind='dkb_group' THEN 0 WHEN kind='action_reply' THEN 1 ELSE 2 END,first_seen_at,id LIMIT 1) RETURNING *`).bind(now + 90_000, now, now).first<Job>();
  if (!job) return 3_000;
  // During a rolling deployment the old worker may have completed an imported
  // pending record. Respect that receipt rather than replaying the message.
  const originals = await env.DB.prepare(`SELECT COUNT(*) AS total,SUM(
    EXISTS(SELECT 1 FROM kap_disclosures k WHERE q.source_ref LIKE 'kap:%' AND k.disclosure_id=substr(q.source_ref,5) AND k.telegram_status IN ('sent','baseline')) OR
    EXISTS(SELECT 1 FROM rss_items r WHERE q.source_ref LIKE 'rss:%' AND r.content_hash=substr(q.source_ref,5) AND r.telegram_status IN ('sent','baseline')) OR
    EXISTS(SELECT 1 FROM spk_bulletins s WHERE q.source_ref LIKE 'spk:%' AND s.bulletin_number=substr(q.source_ref,5) AND s.telegram_status IN ('sent','baseline'))
    ) AS completed FROM telegram_outbox q WHERE (id=? OR group_id=?) AND source_ref IS NOT NULL`).bind(job.id,job.id).first<{total:number;completed:number}>();
  if (originals && originals.total>0 && originals.total===originals.completed) {
    await env.DB.prepare("UPDATE telegram_outbox SET status='superseded',lease_until=0 WHERE id=? OR group_id=?").bind(job.id,job.id).run();
    return 1100;
  }
  if (job.kind === 'dkb_group' || /^(?:kap|spk|rss):/.test(job.source_ref ?? '')) {
    await env.DB.prepare("UPDATE telegram_outbox SET status='superseded',lease_until=0 WHERE id=? OR group_id=?").bind(job.id,job.id).run();
    return 1100;
  }
  const payload = JSON.parse(job.payload) as DeliveryPayload;
  let messageId: number;
  try {
    if (env.TELEGRAM_WEBHOOK_SECRET && job.kind === 'message' && job.source_ref) {
      const item = await env.DB.prepare('SELECT * FROM feed_items WHERE source_ref=?').bind(job.source_ref).first<FeedItem>();
      if (item) payload.keyboard = feedKeyboard(item,payload.button);
    }
    messageId = payload.document
      ? await sendDocument(env, payload.document.url, payload.document.filename)
      : await sendMessage(env, payload.plain ? escapeTelegramHtml(payload.text ?? '') : payload.text ?? '', payload.button, {keyboard:payload.keyboard,replyTo:payload.replyTo});
  } catch (cause) {
    const error = cause instanceof TelegramError ? cause : null;
    const delay = retryDelay(job.attempts, error?.retryAfter);
    const blocked = error && [400, 401, 403, 404].includes(error.status);
    const detail = error?.message ?? 'Telegram network error or timeout (delivery uncertain)';
    await env.DB.batch([
      env.DB.prepare("UPDATE telegram_outbox SET status=?,available_at=?,last_error=?,lease_until=0 WHERE id=?").bind(blocked ? 'blocked' : 'pending', now + delay, detail, job.id),
      ...(error?.status === 429 ? [env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('telegram_cooldown_until',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(now + delay))] : []),
    ]);
    return error?.status === 429 ? delay : 1100;
  }
  const sentAt = new Date().toISOString();
  // Persist API acceptance and original source status in one transaction.
  await env.DB.batch([
    env.DB.prepare("UPDATE telegram_outbox SET status='sent',sent_at=?,message_id=?,lease_until=0,last_error=NULL WHERE id=? OR group_id=?").bind(sentAt, messageId, job.id, job.id),
    ...[['kap_disclosures','disclosure_id','kap:'], ['rss_items','content_hash','rss:'], ['spk_bulletins','bulletin_number','spk:']].map(([table, key, prefix]) => env.DB.prepare(`UPDATE ${table} SET telegram_status='sent',telegram_sent_at=? WHERE ${key} IN
      (SELECT substr(source_ref,5) FROM telegram_outbox WHERE (id=? OR group_id=?) AND source_ref LIKE ?)`)
      .bind(sentAt, job.id, job.id, prefix+'%')),
  ]);
  return env.TELEGRAM_CHAT_ID?.startsWith('-') ? 3100 : 1100;
}

export async function pollDelivery(env: Env): Promise<number> {
  return deliverOne(env);
}
