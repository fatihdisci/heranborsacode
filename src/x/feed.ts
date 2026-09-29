import type { Env } from '../types';
import { feedStatement } from '../db/feed';
import { getState, financeNotificationCutoff, recentNewsForTelegram } from '../db/state';
import { enqueueStatement } from '../telegram/outbox';
import { escapeTelegramHtml } from '../utils/text';
import { findTickers, isFundCrisisNews } from '../rss/filter';
import { isTrackedAccount } from './sources';

export interface XPost { id: string; text: string; publishedAt: string; }
// These are general-news accounts: do not admit politics merely because it
// mentions a broad word such as "yatırım", "para" or a brand name.
export function isFinancialPost(text: string): boolean {
  const normalized = text.toLocaleLowerCase('tr-TR');
  return /(?:^|[^\p{L}\p{N}])(?:borsa(?:da|dan|nın|ya|yı|sı)?|bist(?:100|30|50)?|spk|tefas|kap)(?=$|[^\p{L}\p{N}])/u.test(normalized)
    || /yatırım fon|yatırımcı.{0,35}fon|fon.{0,35}yatırımcı|serbest fon|emeklilik fon|para piyasası fon|fon.{0,25}(?:tasfiye|portföy)|portföy.{0,25}(?:yönetim|fon)|hisse sened|halka arz|sermaye piyas|temettü|bedelsiz sermaye|pay geri alım|borsa manipülasyon|fon(?:lar[ıın]*)? (?:soruşturma|operasyon|vurgun|dolandır|mağdur)|özata denizcilik|destek faktoring|destek yatırım bankası/u.test(normalized);
}

export function parsePosts(value: unknown, now = Date.now()): XPost[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid_posts');
  const result = new Map<string, XPost>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid_post');
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== 'string' || !/^\d{15,22}$/.test(p.id) || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 30_000 || typeof p.publishedAt !== 'string') throw new Error('invalid_post');
    const time = Date.parse(p.publishedAt);
    if (!Number.isFinite(time) || time > now + 60_000) throw new Error('invalid_post_date');
    result.set(p.id, { id: p.id, text: p.text.trim(), publishedAt: new Date(time).toISOString() });
  }
  return [...result.values()].sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}

export async function ingestPosts(env: Env, account: string, input: unknown): Promise<{ inserted: number; baseline: boolean }> {
  if (!isTrackedAccount(account)) throw new Error('unknown_account');
  const posts = parsePosts(input);
  const key = `x_cursor:${account}`;
  const saved = await getState(env, key);
  const now = new Date().toISOString();
  const cursor: { id: string; startedAt: string } = saved ? JSON.parse(saved) : { id:'0', startedAt:now };
  const cutoff = Math.max(Date.parse(cursor.startedAt), (await financeNotificationCutoff(env)) ?? 0);
  const statements: D1PreparedStatement[] = [];
  let inserted = 0;
  for (const post of posts) {
    if (BigInt(post.id) <= BigInt(cursor.id)) continue;
    cursor.id = post.id;
    if (!saved || Date.parse(post.publishedAt) < cutoff || !isFinancialPost(post.text)) continue;
    const ref = `x:${post.id}`;
    if (await env.DB.prepare('SELECT id FROM feed_items WHERE source_ref=?').bind(ref).first()) continue;
    const url = `https://x.com/${account}/status/${post.id}`;
    const source = `X · @${account}`;
    const title = post.text.length > 160 ? post.text.slice(0,157) + '…' : post.text;
    const tickers = JSON.stringify(findTickers(post.text));
    const crisis=isFundCrisisNews(post.text);
    statements.push(feedStatement(env, { type:'news', source, source_ref:ref, title, body:post.text, url, tickers_json:tickers, published_at:post.publishedAt }));
    const excerpt = post.text.length > 900 ? post.text.slice(0,897) + '…' : post.text;
    if(recentNewsForTelegram(post.publishedAt,Date.parse(now)))statements.push(enqueueStatement(env, ref, crisis?'priority_message':'message', {
      text:`${crisis?'⚠️ <b>Fon gelişmesi · X sinyali</b>\nResmî açıklama ayrıca doğrulanmalı.\n\n':''}📰 <b>${escapeTelegramHtml(source)}</b>\n\n${escapeTelegramHtml(excerpt)}\n\n<i>X paylaşımı · Kaynak hesabın aktarımıdır.</i>`,
      button:{text:'🔗 Paylaşımı aç',url},
    }, post.publishedAt));
    inserted++;
  }
  statements.push(env.DB.prepare('INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').bind(key, JSON.stringify(cursor)));
  // Feed, delivery and cursor commit together; a failed write must be retryable.
  await env.DB.batch(statements);
  return { inserted, baseline:!saved };
}
