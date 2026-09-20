import type { Env } from '../types';
import { enqueueStatement } from '../telegram/outbox';
import { RSS_SOURCES } from '../rss/sources';

export interface ShardHealth { startedAt: string; finishedAt: string; nextScheduledAt?: string; lastSuccessAt?: string; failures?: number; error: string | null; }
export function shardProblem(state: ShardHealth, now: number): string | null {
  if ((state.failures ?? 0) >= 3) return 'Üç veya daha fazla ardışık kontrol başarısız.';
  const due = Date.parse(state.nextScheduledAt ?? state.finishedAt);
  if (now > due + 180_000) return 'Zamanlanan kontrol üç dakikadan uzun süredir tamamlanmadı.';
  return null;
}
function label(task: string): string {
  return task.startsWith('rss:') ? RSS_SOURCES[Number(task.slice(4))]?.name ?? task : ({'kap:live':'KAP canlı akışı','kap:backfill':'KAP geçmiş taraması',spk:'SPK',telegram:'Telegram gönderimleri'}[task] ?? task);
}

export async function monitorOperations(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const states = (await env.DB.prepare("SELECT key,value FROM system_state WHERE key LIKE 'poll_shard:%'").all<{key:string;value:string}>()).results ?? [];
  const problems = new Map<string,string>();
  for (const row of states) {
    const task = row.key.slice('poll_shard:'.length);
    if (task === 'monitor') continue;
    const state = JSON.parse(row.value) as ShardHealth;
    // Old versions did not record the next planned run (notably for SPK).
    // Wait for the first new heartbeat instead of creating a migration alarm.
    if (!state.nextScheduledAt) continue;
    const problem = shardProblem(state,Date.now());
    if (problem) problems.set(task,`${label(task)}: ${problem}`);
  }
  const queue = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status IN ('pending','sending','buffered') THEN 1 ELSE 0 END),0) AS waiting,
    COALESCE(SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END),0) AS blocked,
    MIN(CASE WHEN status IN ('pending','sending','buffered') THEN first_seen_at END) AS oldest
    FROM telegram_outbox WHERE status IN ('pending','sending','buffered','blocked')`).first<{waiting:number|null;blocked:number|null;oldest:string|null}>();
  const oldestMs = queue?.oldest ? Date.parse(queue.oldest.includes('T') ? queue.oldest : queue.oldest.replace(' ','T')+'Z') : Date.now();
  if ((queue?.waiting ?? 0) > 100 || Date.now()-oldestMs > 180_000 || (queue?.blocked ?? 0) > 0) {
    problems.set('delivery-queue',`Gönderim kuyruğu: ${queue?.waiting ?? 0} bekleyen, ${queue?.blocked ?? 0} gönderilemeyen kayıt. En eski bekleme ${Math.floor((Date.now()-oldestMs)/1000)} saniye.`);
  }
  const active = (await env.DB.prepare('SELECT id,opened_at FROM operational_incidents WHERE resolved_at IS NULL').all<{id:string;opened_at:string}>()).results ?? [];
  for (const [id,detail] of problems) {
    if (active.some(incident=>incident.id===id)) continue;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO operational_incidents(id,opened_at,detail,resolved_at) VALUES (?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET opened_at=excluded.opened_at,detail=excluded.detail,resolved_at=NULL').bind(id,now,detail),
      enqueueStatement(env,`alert:${id}:${now}`,'message',{text:`⚠️ Heran Borsa\n\n${detail}`,plain:true},null,now,null),
    ]);
  }
  for (const incident of active) {
    if (problems.has(incident.id)) continue;
    await env.DB.batch([
      env.DB.prepare('UPDATE operational_incidents SET resolved_at=? WHERE id=?').bind(now,incident.id),
      enqueueStatement(env,`recovery:${incident.id}:${incident.opened_at}`,'message',{text:`✅ Heran Borsa\n\n${label(incident.id)} yeniden sağlıklı.`,plain:true},null,now,null),
    ]);
  }
  // The bounded sample avoids full-history aggregates on every cron.
  const latency = await env.DB.prepare(`SELECT COUNT(*) AS samples,
    ROUND(AVG((julianday(sent_at)-julianday(first_seen_at))*86400),1) AS meanDeliverySeconds,
    ROUND(MAX((julianday(sent_at)-julianday(first_seen_at))*86400),1) AS maxDeliverySeconds,
    ROUND(AVG(CASE WHEN published_at IS NOT NULL THEN (julianday(first_seen_at)-julianday(published_at))*86400 END),1) AS meanPublicationToSeenSeconds
    FROM (SELECT first_seen_at,published_at,sent_at FROM telegram_outbox WHERE source_ref IS NOT NULL AND status='sent' ORDER BY first_seen_at DESC LIMIT 500)`)
    .first();
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('operations_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(JSON.stringify({checkedAt:now,queue,latency,incidents:[...problems.keys()]})).run();
}
