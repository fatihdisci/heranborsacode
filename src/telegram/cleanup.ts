import type {Env} from '../types';
import {telegramCall} from './client';

interface CleanupRow {message_id:number;sent_at:string;}
/** One-time, bounded cleanup of messages whose IDs were recorded by the old bot. */
export async function cleanupLegacyMessages(env:Env):Promise<void> {
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID) return;
  const done=await env.DB.prepare("SELECT value FROM system_state WHERE key='telegram_legacy_cleanup_done'").first();
  if(done) return;
  await env.DB.prepare("UPDATE telegram_legacy_cleanup SET status='expired' WHERE status='pending' AND julianday(sent_at)<julianday('now','-47 hours')").run();
  for(let batch=0;batch<3;batch++) {
    const rows=(await env.DB.prepare("SELECT message_id,sent_at FROM telegram_legacy_cleanup WHERE status='pending' ORDER BY sent_at DESC LIMIT 100").all<CleanupRow>()).results??[];
    if(!rows.length) {
      await env.DB.prepare("INSERT OR IGNORE INTO system_state(key,value) VALUES ('telegram_legacy_cleanup_done',CURRENT_TIMESTAMP)").run();
      return;
    }
    const ids=rows.map(row=>row.message_id);
    try {
      await telegramCall(env,'deleteMessages',new URLSearchParams({chat_id:env.TELEGRAM_CHAT_ID,message_ids:JSON.stringify(ids)}));
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      await env.DB.prepare(`UPDATE telegram_legacy_cleanup SET attempted_at=CURRENT_TIMESTAMP,last_error=? WHERE message_id IN (${ids.map(()=>'?').join(',')})`).bind(message.slice(0,180),...ids).run();
      throw error;
    }
    await env.DB.prepare(`UPDATE telegram_legacy_cleanup SET status='deleted',attempted_at=CURRENT_TIMESTAMP,last_error=NULL WHERE message_id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).run();
  }
}
