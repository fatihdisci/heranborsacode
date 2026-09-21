import type { Env, FeedItem } from '../types';
import { json } from '../utils/http';
import { sendMessage, telegramCall } from './client';
import { feedKeyboard } from './buttons';
import { wakeActions } from './actions';
import { enqueueTemplateJob, KURUM_TEMPLATE_ID, TERANE_TEMPLATE_ID } from '../commands/jobs';

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

const MINI_APP_URL = 'https://heranborsa.arvia.site';
const BOT_COMMANDS = [
  {command:'start',description:'Heran Borsa ana menüsü'},
  {command:'panel',description:'Mini App komut merkezini aç'},
  {command:'kurum',description:'Kurum analiz şablonunu çalıştır'},
  {command:'terane',description:'Terane derinlik şablonunu çalıştır'},
  {command:'sablonlar',description:'Kayıtlı şablonları göster'},
  {command:'durum',description:'Son komut işlerinin durumunu göster'},
  {command:'iptal',description:'Bekleyen son komut işini iptal et'},
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

async function handleMessage(env: Env, message: IncomingMessage): Promise<void> {
  const permitted = message.chat?.type === 'private' && String(message.chat.id) === env.TELEGRAM_CHAT_ID
    && String(message.from?.id ?? '') === env.TELEGRAM_CHAT_ID;
  if (!permitted || !message.text?.startsWith('/')) return;
  const command = message.text.split(/\s|@/)[0].toLowerCase();
  const panel = { keyboard: [[{ text: '🎛 Komut Merkezini Aç', web_app: { url: MINI_APP_URL } }]] };
  if (['/start','/panel','/komut','/komutlar'].includes(command)) {
    await sendMessage(env, '<b>Heran Borsa Komut Merkezi</b>\n\nBot, komut ve hisseleri seçebilir; kendi şablonlarını oluşturup sonuçları bu sohbetten alabilirsin.', undefined, panel);
    return;
  }
  if (command === '/kurum' || command === '/terane') {
    const templateId = command === '/kurum' ? KURUM_TEMPLATE_ID : TERANE_TEMPLATE_ID;
    try {
      const job = await enqueueTemplateJob(env,templateId,`telegram:${message.chat.id}:${message.message_id}:${command}`);
      if (!job.created) return;
      await sendMessage(env,`⏳ <b>${job.name}</b> kuyruğa alındı. ${job.steps.length} komut tamamlanınca birleşik sonuç bu sohbete gelecek.`);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      await sendMessage(env,code === 'queue_full' ? 'Komut kuyruğu dolu. Devam eden işler tamamlandıktan sonra yeniden deneyin.' : 'Şablon başlatılamadı. Mini App üzerinden durumunu kontrol edin.');
    }
    return;
  }
  if (command === '/sablonlar') {
    const rows = await env.DB.prepare('SELECT name,steps_json FROM command_templates ORDER BY updated_at DESC LIMIT 15').all<{name:string;steps_json:string}>();
    const lines = (rows.results ?? []).map(row => `• <b>${row.name.replace(/[<&>]/g, '')}</b> · ${JSON.parse(row.steps_json).length} komut`);
    await sendMessage(env, lines.length ? `<b>Kayıtlı şablonlar</b>\n\n${lines.join('\n')}` : 'Henüz kayıtlı şablon yok.', undefined, panel);
    return;
  }
  if (command === '/durum') {
    const rows = await env.DB.prepare("SELECT name,status,created_at FROM command_jobs ORDER BY created_at DESC LIMIT 8").all<{name:string;status:string;created_at:string}>();
    const labels: Record<string,string> = {queued:'Bekliyor',leased:'Çalışıyor',completed:'Tamamlandı',failed:'Hata',cancelled:'İptal'};
    const lines = (rows.results ?? []).map(row => `• ${row.name.replace(/[<&>]/g, '')}: <b>${labels[row.status] ?? row.status}</b>`);
    await sendMessage(env, lines.length ? `<b>Son işler</b>\n\n${lines.join('\n')}` : 'Henüz komut işi yok.', undefined, panel);
    return;
  }
  if (command === '/iptal') {
    const job = await env.DB.prepare("SELECT id,name FROM command_jobs WHERE status='queued' ORDER BY created_at DESC LIMIT 1").first<{id:string;name:string}>();
    if (!job) { await sendMessage(env, 'İptal edilebilecek bekleyen iş yok.'); return; }
    await env.DB.prepare("UPDATE command_jobs SET status='cancelled',finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").bind(job.id).run();
    await sendMessage(env, `“${job.name.replace(/[<&>]/g, '')}” iptal edildi.`);
  }
}

async function handleUpdate(env: Env, value: unknown, ctx: Pick<ExecutionContext,'waitUntil'>): Promise<Response> {
  const update = value as {callback_query?: Callback; message?: IncomingMessage} | null;
  if (update?.callback_query) return handleCallback(env,value,ctx);
  if (update?.message) ctx.waitUntil(handleMessage(env,update.message));
  return json({ok:true});
}

const WEBHOOK_URL = 'https://heranborsa.arvia.site/api/telegram/webhook';
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
    return handleUpdate(env,value,ctx);
  }
  if (!['GET','POST'].includes(request.method)) return json({error:'method_not_allowed'},405);
  const info = await telegramCall<WebhookInfo>(env,'getWebhookInfo',new URLSearchParams());
  if (request.method === 'GET') return json({configured:info.url === WEBHOOK_URL,pendingUpdates:info.pending_update_count,lastErrorAt:info.last_error_date ?? null,allowedUpdates:info.allowed_updates});
  // Never replace a different application's webhook.
  if (info.url && info.url !== WEBHOOK_URL) return json({error:'different_webhook_exists'},409);
  await telegramCall(env,'setWebhook',new URLSearchParams({url:WEBHOOK_URL,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:JSON.stringify(['callback_query','message']),max_connections:'2',drop_pending_updates:'false'}));
  await setBotCommands(env);
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

export async function ensureTelegramWebhook(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return;
  const version = await env.DB.prepare("SELECT value FROM system_state WHERE key='telegram_webhook_version'").first<{value:string}>();
  if (version?.value === 'custom-domain-v3') return;
  await telegramCall(env,'setWebhook',new URLSearchParams({url:WEBHOOK_URL,secret_token:env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates:JSON.stringify(['callback_query','message']),max_connections:'2',drop_pending_updates:'false'}));
  await telegramCall(env,'setChatMenuButton',new URLSearchParams({menu_button:JSON.stringify({type:'web_app',text:'Heran Borsa',web_app:{url:MINI_APP_URL}})}));
  await setBotCommands(env);
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('telegram_webhook_version','custom-domain-v3') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run();
}
