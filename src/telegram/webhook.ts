import type { Env, FeedItem } from '../types';
import { json } from '../utils/http';
import { telegramCall } from './client';
import { feedKeyboard } from './buttons';
import { wakeActions } from './actions';

interface Callback {
  id: string; data: string; from: {id:number;username?:string};
  message: {message_id:number;chat:{id:number;type:string}};
}
async function answer(env: Env, id: string, text: string): Promise<void> {
  try { await telegramCall(env,'answerCallbackQuery',new URLSearchParams({callback_query_id:id,text})); }
  catch { /* Old callbacks can expire. Their persisted job is still delivered. */ }
}

export async function handleCallback(env: Env, value: unknown, ctx: Pick<ExecutionContext,'waitUntil'>): Promise<Response> {
  const cb = (value as {callback_query?:Callback} | null)?.callback_query;
  if (!cb || typeof cb.id !== 'string' || typeof cb.data !== 'string') return json({ok:true});
  const permitted = cb.message?.chat?.type === 'private' && String(cb.message.chat.id) === env.TELEGRAM_CHAT_ID
    && String(cb.from?.id) === env.TELEGRAM_CHAT_ID && Number.isSafeInteger(cb.message.message_id);
  const ack = (text: string) => ctx.waitUntil(answer(env,cb.id,text));
  if (!permitted) { ack('Bu buton yalnızca yetkili özel sohbette kullanılabilir.'); return json({ok:true}); }
  const match = /^(read|tweet):([1-9]\d{0,14})$/.exec(cb.data);
  const page = /^page:([a-f0-9-]{36}):([1-9]\d{0,4})$/.exec(cb.data);
  if (!match && !page) { ack('Bu buton artık kullanılamıyor.'); return json({ok:true}); }
  const action = match?.[1] ?? 'page';
  let itemId = match ? Number(match[2]) : 0;
  if (page) {
    const root = await env.DB.prepare("SELECT feed_item_id,result_text FROM telegram_actions WHERE id=? AND action='read' AND status='done'").bind(page[1]).first<{feed_item_id:number;result_text:string}>();
    if (!root || !JSON.parse(root.result_text)[Number(page[2])]) { ack('Bu içerik bulunamadı. Yeniden “Oku”ya basın.'); return json({ok:true}); }
    itemId = root.feed_item_id;
  }
  const item = await env.DB.prepare('SELECT * FROM feed_items WHERE id=?').bind(itemId).first<FeedItem>();
  if (!item || item.type === 'spk' || (item.type === 'kap' && /devre kesici/i.test(item.title))) {
    ack('Bu kayıt için kaynak bağlantısını kullanın.'); return json({ok:true});
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO telegram_actions
    (id,callback_id,action,feed_item_id,reply_to,page_ref,page_index,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM telegram_actions WHERE feed_item_id=? AND action=? AND COALESCE(page_ref,'')=? AND page_index=?
      AND (status IN ('queued','processing') OR (status='done' AND created_at>?)))
    AND (SELECT COUNT(*) FROM telegram_actions WHERE created_at>?)<6
    AND (SELECT COUNT(*) FROM telegram_actions WHERE status IN ('queued','processing'))<8`)
    .bind(id,cb.id,action,itemId,cb.message.message_id,page?.[1] ?? null,Number(page?.[2] ?? 0),now,
      itemId,action,page?.[1] ?? '',Number(page?.[2] ?? 0),now-15_000,now-60_000).run();
  ack(inserted.meta.changes ? (action === 'tweet' ? 'Tweet hazırlanıyor; hazır olduğunda bu sohbete gelecek.' : 'Metin hazırlanıyor; bu sohbete gönderilecek.')
    : 'İstek zaten alındı veya çok hızlı tıkladınız. Biraz bekleyin.');
  // Always wake on retries too, in case insertion succeeded but scheduling failed.
  await wakeActions(env,action === 'tweet' ? 'tweet' : 'read');
  return json({ok:true});
}

const WEBHOOK_URL = 'https://heranborsa.av-fatihdisci.workers.dev/api/telegram/webhook';
interface WebhookInfo {url:string;pending_update_count:number;last_error_date?:number;last_error_message?:string;allowed_updates?:string[];}

export async function telegramRoutes(request: Request, env: Env, ctx: Pick<ExecutionContext,'waitUntil'>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/telegram/webhook' && path !== '/api/telegram/setup') return null;
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) return json({error:'unauthorized'},401);
  if (path === '/api/telegram/webhook') {
    if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
    const body = await request.text();
    if (body.length > 32_000) return json({error:'too_large'},413);
    let value: unknown;
    try { value = JSON.parse(body); } catch { return json({error:'invalid_json'},400); }
    return handleCallback(env,value,ctx);
  }
  if (!['GET','POST'].includes(request.method)) return json({error:'method_not_allowed'},405);
  const info = await telegramCall<WebhookInfo>(env,'getWebhookInfo',new URLSearchParams());
  if (request.method === 'GET') return json({configured:info.url === WEBHOOK_URL,pendingUpdates:info.pending_update_count,lastErrorAt:info.last_error_date ?? null,allowedUpdates:info.allowed_updates});
  // Never replace a different application's webhook.
  if (info.url && info.url !== WEBHOOK_URL) return json({error:'different_webhook_exists'},409);
  await telegramCall(env,'setWebhook',new URLSearchParams({url:WEBHOOK_URL,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:JSON.stringify(['callback_query']),max_connections:'2',drop_pending_updates:'false'}));
  const recent = await env.DB.prepare(`SELECT f.*,q.message_id FROM telegram_outbox q JOIN feed_items f ON f.source_ref=q.source_ref
    WHERE q.status='sent' AND q.kind='message' AND q.message_id IS NOT NULL AND f.type IN ('news','kap')
    ORDER BY q.sent_at DESC LIMIT 10`).all<FeedItem & {message_id:number}>();
  let updated = 0, skipped = 0;
  for (const item of recent.results) {
    if (/devre kesici/i.test(item.title)) continue;
    try {
      await telegramCall(env,'editMessageReplyMarkup',new URLSearchParams({chat_id:env.TELEGRAM_CHAT_ID!,message_id:String(item.message_id),reply_markup:JSON.stringify({inline_keyboard:feedKeyboard(item)})}));
      updated++;
    } catch { skipped++; }
  }
  return json({configured:true,updatedRecentMessages:updated,skipped});
}
