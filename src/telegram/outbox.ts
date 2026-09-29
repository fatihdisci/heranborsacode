import { getPreferences, decide, markers, symbols } from "../notifications/rules";
import { getIndices } from "../notifications/indices";
import type { Env } from "../types";
import { escapeTelegramHtml, sha256 } from "../utils/text";
import { sendDocument, sendMessage, TelegramError } from "./client";
import type { InlineButton } from './client';
import type { FeedItem } from '../types';
import { feedKeyboard } from './buttons';
import { feedJoinSql, subjectTickersSql } from '../db/feed';
import { recentNewsForTelegram } from '../db/state';

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
interface Job { id: string; source_ref: string | null; kind: string; payload: string; attempts: number; first_seen_at: string; published_at:string|null; }
function utcTime(value: string): number { return Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z'); }

// The AI-era outbox remains in D1. Never deliver its pending source messages,
// action replies, or operational alerts after the finance runtime returns.
export const financeOutboxPredicate = `(q.source_ref LIKE 'kap:%' OR q.source_ref LIKE 'spk:%' OR q.source_ref LIKE 'rss:%' OR q.source_ref LIKE 'x:%'
  OR q.id LIKE 'digest:%' OR q.id LIKE 'dkb:%'
  OR (q.id LIKE 'action:%' AND EXISTS (
    SELECT 1 FROM telegram_actions a JOIN feed_items f ON f.id=a.feed_item_id
    WHERE q.id='action:' || a.id AND f.category IS NULL))
  OR q.id LIKE 'alert:x:%' OR q.id LIKE 'recovery:x:%'
  OR q.id LIKE 'alert:kap:%' OR q.id LIKE 'alert:spk:%' OR q.id LIKE 'alert:rss:%'
  OR q.id LIKE 'alert:telegram:%' OR q.id LIKE 'alert:delivery-queue:%'
  OR q.id LIKE 'recovery:kap:%' OR q.id LIKE 'recovery:spk:%' OR q.id LIKE 'recovery:rss:%'
  OR q.id LIKE 'recovery:telegram:%' OR q.id LIKE 'recovery:delivery-queue:%')
  AND ((SELECT value FROM system_state WHERE key='finance_notification_cutoff_at') IS NULL
    OR ((q.source_ref LIKE 'kap:%' OR q.source_ref LIKE 'rss:%' OR q.source_ref LIKE 'x:%')
      AND q.published_at >= (SELECT value FROM system_state WHERE key='finance_notification_cutoff_at'))
    OR (q.source_ref LIKE 'spk:%' AND q.first_seen_at >= (SELECT value FROM system_state WHERE key='finance_notification_cutoff_at')
      AND q.published_at IS NOT NULL AND julianday(q.published_at)+1 > julianday((SELECT value FROM system_state WHERE key='finance_notification_cutoff_at')))
    OR (q.id LIKE 'dkb:%' AND EXISTS (SELECT 1 FROM telegram_outbox child
      WHERE child.group_id=q.id AND child.published_at >= (SELECT value FROM system_state WHERE key='finance_notification_cutoff_at')))
    OR (q.source_ref IS NULL AND q.id NOT LIKE 'dkb:%'))`;

export function enqueueStatement(env: Env, id: string, kind: string, payload: DeliveryPayload, publishedAt: string | null, firstSeen = new Date().toISOString(), sourceRef: string | null = id): D1PreparedStatement {
  return env.DB.prepare(`INSERT OR IGNORE INTO telegram_outbox
    (id,source_ref,kind,payload,status,first_seen_at,published_at,available_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, sourceRef, kind, JSON.stringify(payload), kind === "dkb" ? "buffered" : "pending", firstSeen, publishedAt, Date.now());
}

export function retryDelay(attempt: number, retryAfter = 0): number {
  return Math.max(retryAfter * 1000, Math.min(300_000, 5000 * 2 ** Math.min(attempt - 1, 6)));
}

export async function flushCircuitBreakers(env: Env, now = Date.now()): Promise<void> {
  const rows = (await env.DB.prepare(`SELECT q.id,q.payload,q.first_seen_at,
    CASE WHEN f.id IS NULL THEN NULL ELSE json_object('type',f.type,'title',f.title,'body',f.body,'tickers_json',f.tickers_json,'subject_tickers_json',''||(${subjectTickersSql})) END AS feed_json
    FROM telegram_outbox q LEFT JOIN feed_items f ON f.source_ref=q.source_ref AND f.category IS NULL ${feedJoinSql}
    WHERE q.status='buffered' AND q.source_ref LIKE 'kap:%'
      AND ((SELECT value FROM system_state WHERE key='finance_notification_cutoff_at') IS NULL
        OR q.published_at >= (SELECT value FROM system_state WHERE key='finance_notification_cutoff_at'))
    ORDER BY q.first_seen_at,q.id LIMIT 100`).all<Job & {feed_json:string|null}>()).results ?? [];
  if (!rows.length || now < utcTime(rows[0].first_seen_at) + DKB_WINDOW_MS) return;
  const cutoff = utcTime(rows[0].first_seen_at) + DKB_WINDOW_MS;
  const candidates = rows.filter(row => utcTime(row.first_seen_at) <= cutoff);
  const preferences=await getPreferences(env),indices=await getIndices(env);
  const group:Job[]=[],filtered:D1PreparedStatement[]=[];
  for(const row of candidates) {
    const item=row.feed_json?JSON.parse(row.feed_json) as FeedItem:null;
    if(item && decide(item,preferences,indices).action==='off') {
      filtered.push(env.DB.prepare("UPDATE telegram_outbox SET status='filtered',last_error='Bildirim kuralı' WHERE id=? AND status='buffered'").bind(row.id));
    } else group.push(row);
  }
  if(filtered.length)await env.DB.batch(filtered);
  if(!group.length)return;
  const codes = [...new Set(group.flatMap(row => (JSON.parse(row.payload) as DeliveryPayload).codes ?? []))];
  const id = `dkb:${await sha256(group.map(row => row.id).join('|'))}`;
  const label=markers(codes,preferences,indices);
  const text = `${label ? label+"\n\n" : ""}${codes.map(code => `#${code}`).join(' ')}\n\nDevre kesici uygulandı. Sürekli işleme ara verildi.`;
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
    WHERE id=(SELECT q.id FROM telegram_outbox q WHERE ((q.status='pending' AND q.available_at<=?) OR (q.status='sending' AND q.lease_until<=?))
      AND ${financeOutboxPredicate}
      ORDER BY CASE WHEN kind='dkb_group' THEN 0 WHEN kind='action_reply' THEN 1 WHEN kind='priority_message' THEN 2 ELSE 3 END,first_seen_at,id LIMIT 1) RETURNING *`).bind(now + 90_000, now, now).first<Job>();
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
  if(job.source_ref && /^(rss|x):/.test(job.source_ref) && !recentNewsForTelegram(job.published_at,now)) {
    await env.DB.prepare("UPDATE telegram_outbox SET status='filtered',lease_until=0,last_error='Yayın zamanı eski haber' WHERE id=?").bind(job.id).run();
    return 1100;
  }
  const payload = JSON.parse(job.payload) as DeliveryPayload;
  let messageId: number;
  try {
    if ((job.kind === 'message' || job.kind === 'priority_message') && job.source_ref) {
      const item = await env.DB.prepare(`SELECT f.*,${subjectTickersSql} AS subject_tickers_json FROM feed_items f ${feedJoinSql} WHERE f.source_ref=? AND f.category IS NULL`).bind(job.source_ref).first<FeedItem>();
      if(item) {
        const preferences=await getPreferences(env),indices=await getIndices(env);
        const decision=decide(item,preferences,indices);
        if(decision.action!=='instant') {
          await env.DB.prepare("UPDATE telegram_outbox SET status=?,available_at=?,lease_until=0,last_error=? WHERE id=?")
            .bind(decision.action==='digest'?'digest':'filtered',nextDigestAt(utcTime(job.first_seen_at)||now,preferences.digestHour),decision.reason,job.id).run();
          return 1100;
        }
        const label=markers(symbols(item),preferences,indices);
        if(label)payload.text=label+'\n\n'+(payload.text??'');
        if(env.TELEGRAM_WEBHOOK_SECRET)payload.keyboard=feedKeyboard(item,payload.button);
      }
    }
    if(job.kind==='daily_digest') {
      const preferences=await getPreferences(env);
      if(preferences.funds==='off') {
        await env.DB.prepare("UPDATE telegram_outbox SET status='filtered',lease_until=0,last_error='Fon bildirimleri kapalı' WHERE id=? OR group_id=?").bind(job.id,job.id).run();
        return 1100;
      }
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
  await flushDailyDigest(env);
  await flushCircuitBreakers(env);
  return deliverOne(env);
}

// Europe/Istanbul is UTC+03:00; this is the next selected local hour.
export function nextDigestAt(now:number,hour:number):number {
  const local=new Date(now+3*3600_000);
  let due=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),hour-3);
  if(due<=now)due+=24*3600_000;
  return due;
}
export async function flushDailyDigest(env:Env,now=Date.now()):Promise<void> {
  const candidates=(await env.DB.prepare(`SELECT q.id,q.first_seen_at,f.title,f.body,f.url FROM telegram_outbox q
    JOIN feed_items f ON f.source_ref=q.source_ref WHERE q.status='digest' AND q.available_at<=? AND f.category IS NULL
    AND ${financeOutboxPredicate} ORDER BY q.available_at,q.id LIMIT 8`).bind(now).all<{id:string;first_seen_at:string;title:string;body:string|null;url:string}>()).results??[];
  if(!candidates.length)return;
  const preferences=await getPreferences(env),indices=await getIndices(env);
  const rows:typeof candidates=[],filtered:D1PreparedStatement[]=[];
  for(const row of candidates) {
    const decision=decide({...row,id:0,type:'kap',tickers_json:'[]',source:'KAP',source_ref:row.id,published_at:null,created_at:row.first_seen_at},preferences,indices);
    if(decision.action==='off')filtered.push(env.DB.prepare("UPDATE telegram_outbox SET status='filtered',last_error=? WHERE id=? AND status='digest'").bind(decision.reason,row.id));
    else rows.push(row);
  }
  if(filtered.length)await env.DB.batch(filtered);
  if(!rows.length)return;
  const id='digest:' +await sha256(rows.map(r=>r.id).join('|'));
  const date=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',day:'2-digit',month:'2-digit',year:'numeric'}).format(now);
  const text=`🏦 <b>Fon bildirimleri · Günlük özet · ${date}</b>\n${rows.length} kayıt (yoğun günlerde bölümler halinde)\n\n`+rows.map(r=>`• <a href="${escapeTelegramHtml(r.url)}">${escapeTelegramHtml(r.title.slice(0,160))}</a>\n${escapeTelegramHtml((r.body??'').slice(0,100))}`).join('\n\n');
  await env.DB.batch([
    enqueueStatement(env,id,'daily_digest',{text},null,rows[0].first_seen_at,null),
    ...rows.map(row=>env.DB.prepare("UPDATE telegram_outbox SET status='grouped',group_id=? WHERE id=? AND status='digest'").bind(id,row.id)),
  ]);
}
