import type { Env, FeedItem } from '../types';
import { readerContent, type ReaderContent } from '../reader/content';
import { generateTweetDraft } from '../ai/tweet';
import { enqueueStatement, type DeliveryPayload } from './outbox';
import { feedKeyboard } from './buttons';

export interface ActionJob {
  id: string; callback_id: string; action: 'read' | 'tweet' | 'page'; feed_item_id: number;
  reply_to: number; page_ref: string | null; page_index: number; created_at: number;
  lease_until: number; result_text: string | null;
}
export type ActionLane = 'read' | 'tweet';

// Leave room for the title, source and page counter under Telegram's 4096 limit.
export function splitText(text: string, limit = 3200): string[] {
  const pages: string[] = [];
  while (text.length > limit) {
    let end = Math.max(text.lastIndexOf('\n', limit), text.lastIndexOf(' ', limit));
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    pages.push(text.slice(0, end));
    text = text.slice(end).trimStart();
  }
  if (text) pages.push(text);
  return pages;
}

export function readerPages(content: ReaderContent): string[] {
  const blocks = content.blocks.map(block => block.type === 'table'
    ? block.rows.map(row => row.map(cell => cell.text).join(' | ')).join('\n') : block.text);
  const attachments = content.attachments.map(file => `${file.filename}: ${file.url}`);
  return splitText([content.notice, ...blocks, ...(attachments.length ? ['Ekler (dosya içerikleri bu metne dahil değildir):', ...attachments] : [])].filter(Boolean).join('\n\n'));
}

function pagePayload(item: FeedItem, job: ActionJob, root: string, pages: string[], index: number): DeliveryPayload {
  const keyboard = feedKeyboard(item);
  if (index + 1 < pages.length) keyboard.unshift([{text:`Devamını oku · ${index + 2}/${pages.length}`,callback_data:`page:${root}:${index + 1}`}]);
  return {text:`${item.title.slice(0,400)}\n${item.source.slice(0,120)} · ${index + 1}/${pages.length}\n\n${pages[index]}`,plain:true,replyTo:job.reply_to,keyboard};
}

async function finish(env: Env, job: ActionJob, payload: DeliveryPayload, result: string | null, status = 'done'): Promise<void> {
  // Reply and completion are committed together. Retried callbacks cannot add a second reply.
  await env.DB.batch([
    enqueueStatement(env,`action:${job.id}`,'action_reply',payload,null,undefined,null),
    env.DB.prepare('UPDATE telegram_actions SET status=?,result_text=?,lease_until=0 WHERE id=?').bind(status,result,job.id),
  ]);
}

export async function processAction(env: Env, lane: ActionLane): Promise<number | null> {
  const now = Date.now();
  const condition = lane === 'tweet' ? "action='tweet'" : "action IN ('read','page')";
  // A process interrupted during an API request must not blindly incur another AI charge.
  const expired = await env.DB.prepare(`SELECT * FROM telegram_actions WHERE status='processing' AND lease_until<=? AND ${condition} ORDER BY created_at LIMIT 1`).bind(now).first<ActionJob>();
  if (expired) {
    await finish(env,expired,{text:'İşlem tamamlanamadı. İlgili mesajdaki butondan yeniden deneyebilirsiniz.',plain:true,replyTo:expired.reply_to},null,'failed');
    return 1000;
  }
  const active = await env.DB.prepare(`SELECT lease_until FROM telegram_actions WHERE status='processing' AND ${condition} LIMIT 1`).first<{lease_until:number}>();
  if (active) return Math.max(1000,active.lease_until-now);
  const job = await env.DB.prepare(`UPDATE telegram_actions SET status='processing',lease_until=? WHERE id=(
    SELECT id FROM telegram_actions WHERE status='queued' AND ${condition} ORDER BY created_at,id LIMIT 1) RETURNING *`).bind(now+180_000).first<ActionJob>();
  if (!job) return null;
  try {
    const item = await env.DB.prepare('SELECT * FROM feed_items WHERE id=?').bind(job.feed_item_id).first<FeedItem>();
    if (!item?.category) throw new Error('item_missing');
    let payload: DeliveryPayload;
    let result: string | null = null;
    if (job.action === 'tweet') {
      const draft = await generateTweetDraft(env,item);
      payload = {text:draft.tweet,plain:true,replyTo:job.reply_to};
      result = draft.tweet;
    } else if (job.action === 'read') {
      const content = await readerContent(env,item);
      if (!content) {
        if (now-job.created_at > 120_000) throw new Error('reader_busy');
        await env.DB.prepare("UPDATE telegram_actions SET status='queued',lease_until=0 WHERE id=?").bind(job.id).run();
        return 2000;
      }
      const pages = readerPages(content);
      if (!pages.length) throw new Error('empty_content');
      result = JSON.stringify(pages);
      payload = pagePayload(item,job,job.id,pages,0);
    } else {
      const root = await env.DB.prepare("SELECT result_text FROM telegram_actions WHERE id=? AND action='read' AND status='done' AND feed_item_id=?").bind(job.page_ref,job.feed_item_id).first<{result_text:string}>();
      const pages = root ? JSON.parse(root.result_text) as string[] : [];
      if (!pages[job.page_index]) throw new Error('page_missing');
      payload = pagePayload(item,job,job.page_ref!,pages,job.page_index);
    }
    await finish(env,job,payload,result);
  } catch (error) {
    console.error('Telegram action failed',{action:job.action,feedItemId:job.feed_item_id,reason:error instanceof Error?error.message.slice(0,200):'unknown'});
    await finish(env,job,{text:job.action === 'tweet'
      ? 'Tweet oluşturulamadı; eksik bir taslak gönderilmedi. İlgili mesajdaki “Tweet oluştur” butonuyla yeniden deneyebilirsiniz.'
      : 'İçerik şu anda okunamadı. Kaynak bağlantısını açabilir veya “Oku” butonuyla yeniden deneyebilirsiniz.',plain:true,replyTo:job.reply_to},null,'failed');
  }
  return 1000;
}

export async function wakeActions(env: Env, lane: ActionLane): Promise<void> {
  const response = await env.TELEGRAM_ACTIONS.get(env.TELEGRAM_ACTIONS.idFromName(lane)).fetch(`https://actions/ensure?lane=${lane}`);
  if (!response.ok) throw new Error('action_scheduler_unavailable');
}

export async function ensureTelegramActions(env: Env): Promise<void> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return;
  const rows = await env.DB.prepare("SELECT DISTINCT CASE WHEN action='tweet' THEN 'tweet' ELSE 'read' END AS lane FROM telegram_actions WHERE status IN ('queued','processing')").all<{lane:ActionLane}>();
  await Promise.all(rows.results.map(row => wakeActions(env,row.lane)));
}
