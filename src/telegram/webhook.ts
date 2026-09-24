import type { Env, FeedItem } from '../types';
import { json } from '../utils/http';
import { sendMessage, telegramCall } from './client';
import { feedKeyboard } from './buttons';
import { wakeActions } from './actions';
import { BRAND } from '../config';
import { SOURCES } from '../sources/registry';
import { escapeTelegramHtml } from '../utils/text';
import { publicBaseUrl } from '../config';

interface Callback {
  id: string; data: string; from: {id:number;username?:string};
  message: {message_id:number;chat:{id:number;type:string}};
}
interface IncomingMessage {
  message_id: number;
  text?: string;
  from?: { id: number; username?: string };
  chat: { id: number; type: string };
}

const BOT_COMMANDS = [
  {command:'start',description:'Mini App ve AI radar'},
  {command:'son',description:'Son önemli AI gelişmeleri'},
  {command:'resetler',description:'Codex resetleri'},
  {command:'durum',description:'Kaynak durumu'},
];

async function setBotCommands(env: Env): Promise<void> {
  await telegramCall(env,'setMyCommands',new URLSearchParams({commands:JSON.stringify(BOT_COMMANDS)}));
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
  if (!item?.category) {
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

async function handleMessage(env: Env, message: IncomingMessage): Promise<void> {
  const permitted=message.chat?.type==='private' && String(message.chat.id)===env.TELEGRAM_CHAT_ID && String(message.from?.id??'')===env.TELEGRAM_CHAT_ID;
  if (!permitted || !message.text?.startsWith('/')) return;
  const command=message.text.split(/\s|@/)[0].toLowerCase();
  if (command==='/start') {
    const panel={keyboard:[[{text:`${BRAND.name} aç`,web_app:{url:publicBaseUrl(env)}}]]};
    await sendMessage(env,`<b>${BRAND.name}</b>\n\nAI gelişmelerini tarar ve önemli olanları burada gösterir. Tweet yalnız sen istediğinde hazırlanır; X'e otomatik gönderilmez.`,undefined,panel);
  } else if (command==='/son' || command==='/resetler') {
    const where=command==='/resetler' ? "category='resets'" : "priority='high'";
    const rows=await env.DB.prepare(`SELECT title,url,source FROM feed_items WHERE category IS NOT NULL AND ${where} ORDER BY COALESCE(published_at,created_at) DESC,id DESC LIMIT 6`).all<{title:string;url:string;source:string}>();
    const lines=(rows.results??[]).map(row=>`• <a href="${escapeTelegramHtml(new URL(row.url).toString()).replace(/"/g,'&quot;')}">${escapeTelegramHtml(row.title)}</a> · ${escapeTelegramHtml(row.source)}`);
    await sendMessage(env,lines.length?`<b>${command==='/resetler'?'Codex resetleri':'Son AI gelişmeleri'}</b>\n\n${lines.join('\n')}${command==='/resetler'?'\n\n<a href="https://codex-resets.com/">Veri: Codex Resets</a>':''}`:'Henüz kayıt yok.');
  } else if (command==='/durum') {
    const rows=await env.DB.prepare("SELECT key,value FROM system_state WHERE key LIKE 'poll_shard:source:%'").all<{key:string;value:string}>();
    const states=new Map((rows.results??[]).map(row=>[row.key,JSON.parse(row.value) as {lastSuccessAt?:string;error?:string;failures?:number}]));
    const lines=SOURCES.map(source=>{const state=states.get(`poll_shard:source:${source.id}`);return `${state?.error?'⚠️':state?.lastSuccessAt?'✅':'◌'} ${escapeTelegramHtml(source.name)}${state?.lastSuccessAt?` · ${escapeTelegramHtml(state.lastSuccessAt)}`:''}`;});
    await sendMessage(env,`<b>Kaynak durumu</b>\n\n${lines.join('\n')}`);
  }
}

async function handleUpdate(env: Env, value: unknown, ctx: Pick<ExecutionContext,'waitUntil'>): Promise<Response> {
  const update = value as {callback_query?: Callback; message?: IncomingMessage} | null;
  if (update?.callback_query) return handleCallback(env,value,ctx);
  if (update?.message) ctx.waitUntil(handleMessage(env,update.message));
  return json({ok:true});
}

interface WebhookInfo {url:string;pending_update_count:number;last_error_date?:number;last_error_message?:string;allowed_updates?:string[];}

export async function telegramRoutes(request: Request, env: Env, ctx: Pick<ExecutionContext,'waitUntil'>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/telegram/webhook' && path !== '/api/telegram/setup') return null;
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) return json({error:'unauthorized'},401);
  const webhookUrl = `${publicBaseUrl(env)}/api/telegram/webhook`;
  if (path === '/api/telegram/webhook') {
    if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
    const body = await request.text();
    if (body.length > 32_000) return json({error:'too_large'},413);
    let value: unknown;
    try { value = JSON.parse(body); } catch { return json({error:'invalid_json'},400); }
    return handleUpdate(env,value,ctx);
  }
  if (!['GET','POST'].includes(request.method)) return json({error:'method_not_allowed'},405);
  const info = await telegramCall<WebhookInfo>(env,'getWebhookInfo',new URLSearchParams());
  if (request.method === 'GET') return json({configured:info.url === webhookUrl,pendingUpdates:info.pending_update_count,lastErrorAt:info.last_error_date ?? null,allowedUpdates:info.allowed_updates});
  // Never replace a different application's webhook.
  if (info.url && info.url !== webhookUrl) return json({error:'different_webhook_exists'},409);
  await telegramCall(env,'setWebhook',new URLSearchParams({url:webhookUrl,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:JSON.stringify(['callback_query','message']),max_connections:'2',drop_pending_updates:'false'}));
  await setBotCommands(env);
  const recent = await env.DB.prepare(`SELECT f.*,q.message_id FROM telegram_outbox q JOIN feed_items f ON f.source_ref=q.source_ref
    WHERE q.status='sent' AND q.kind='message' AND q.message_id IS NOT NULL AND f.category IS NOT NULL
    ORDER BY q.sent_at DESC LIMIT 10`).all<FeedItem & {message_id:number}>();
  let updated = 0, skipped = 0;
  for (const item of recent.results) {
    try {
      await telegramCall(env,'editMessageReplyMarkup',new URLSearchParams({chat_id:env.TELEGRAM_CHAT_ID!,message_id:String(item.message_id),reply_markup:JSON.stringify({inline_keyboard:feedKeyboard(item)})}));
      updated++;
    } catch { skipped++; }
  }
  return json({configured:true,updatedRecentMessages:updated,skipped});
}

export async function ensureTelegramWebhook(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return;
  const version = await env.DB.prepare("SELECT value FROM system_state WHERE key='telegram_webhook_version'").first<{value:string}>();
  if (version?.value === 'vibe-radar-v1') return;
  const miniAppUrl = publicBaseUrl(env);
  await telegramCall(env,'setWebhook',new URLSearchParams({url:`${miniAppUrl}/api/telegram/webhook`,secret_token:env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates:JSON.stringify(['callback_query','message']),max_connections:'2',drop_pending_updates:'false'}));
  await telegramCall(env,'setChatMenuButton',new URLSearchParams({menu_button:JSON.stringify({type:'web_app',text:BRAND.name,web_app:{url:miniAppUrl}})}));
  await setBotCommands(env);
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('telegram_webhook_version','vibe-radar-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run();
}
