import type { Env } from '../types';
import { KURUM_TEMPLATE_ID, TERANE_TEMPLATE_ID, SON_HALKA_ARZLAR_TEMPLATE_ID } from './jobs';

const TEMPLATES = [TERANE_TEMPLATE_ID, KURUM_TEMPLATE_ID, SON_HALKA_ARZLAR_TEMPLATE_ID];
const PREFIX = 'command_media_retention:';
const PAGE = 20, JOBS = 2;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Istanbul', year:'numeric',month:'2-digit',day:'2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Istanbul', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' });
const sqlTime = (n:number) => new Date(n).toISOString().replace('T',' ').slice(0,19);
const parts = (f:Intl.DateTimeFormat,n:number) => Object.fromEntries(f.formatToParts(n).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
function dayAt(n:number) { const p=parts(dateFormat,n);return `${p.year}-${p.month}-${p.day}`; }
function midnight(day:string) {
  const wanted=Date.parse(day+'T00:00:00Z');let candidate=wanted;
  for(let i=0;i<2;i++) { const p=parts(clockFormat,candidate);const local=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);candidate=wanted-(local-candidate); }
  return candidate;
}
export function previousTurkeyDay(now=Date.now()) {
  const today=dayAt(now),day=new Date(Date.parse(today+'T00:00:00Z')-86400_000).toISOString().slice(0,10);
  return { day, from:sqlTime(midnight(day)), until:sqlTime(midnight(today)) };
}
interface Job { id:string; template_id:string; name:string; created_at:string; status:string; finished_at:string|null; }
const ELIGIBLE = `j.template_id IN (?,?,?) AND datetime(j.created_at)>=? AND datetime(j.created_at)<?
  AND j.status IN ('completed','failed','cancelled') AND j.finished_at IS NOT NULL AND datetime(j.finished_at)<=?
  AND NOT (j.status='completed' AND j.notified_at IS NULL AND datetime(j.finished_at)>?)
  AND NOT EXISTS (SELECT 1 FROM command_deliveries d WHERE d.job_id=j.id AND d.status='processing' AND datetime(d.updated_at)>?)
  AND NOT EXISTS (SELECT 1 FROM command_workflows w,json_each(w.snapshots_json) s
    WHERE w.status IN ('running','needs_attention') AND json_extract(s.value,'$.job_id')=j.id)`;
function values(now:number) { const d=previousTurkeyDay(now);return [...TEMPLATES,d.from,d.until,sqlTime(now-3600_000),sqlTime(now-86400_000),sqlTime(now-600_000)]; }
async function eligibleJob(env:Env,id:string,now:number) {
  return env.DB.prepare(`SELECT j.id FROM command_jobs j WHERE j.id=? AND ${ELIGIBLE}`).bind(id,...values(now)).first();
}
async function candidates(env:Env,now:number,progress=false) {
  return (await env.DB.prepare(`SELECT j.id,j.template_id,j.name,j.created_at,j.status,j.finished_at FROM command_jobs j
    WHERE ${ELIGIBLE} AND NOT EXISTS (SELECT 1 FROM system_state WHERE key=?||j.id)
    AND NOT EXISTS (SELECT 1 FROM system_state WHERE key=?||j.id)
    AND NOT EXISTS (SELECT 1 FROM system_state WHERE key=?||j.id) ORDER BY j.created_at,j.id LIMIT ?`)
    .bind(...values(now),PREFIX+'done:',PREFIX+'review:',progress?PREFIX+'preview-done:'+previousTurkeyDay(now).day+':':PREFIX+'unused-preview:',JOBS).all<Job>()).results ?? [];
}
function safeKey(key:string,id:string) {
  const prefix=`commands/${id}/`,leaf=key.slice(prefix.length);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) && key.startsWith(prefix) && !!leaf && !leaf.includes('/') && !leaf.includes('..');
}
async function mediaPage(env:Env,job:Job,cursor?:string) {
  const images=(await env.DB.prepare("SELECT media_key FROM command_results WHERE job_id=? AND response_kind='image'").bind(job.id).all<{media_key:string}>()).results ?? [];
  const imageKeys=new Set(images.map(r=>r.media_key));
  const page=await env.COMMAND_MEDIA.list({prefix:`commands/${job.id}/`,limit:PAGE,cursor,include:['httpMetadata']});
  const files=page.objects.filter(o=>safeKey(o.key,job.id) && (imageKeys.has(o.key) ||
    /^image\//i.test(o.httpMetadata?.contentType ?? '') || /^application\/pdf(?:;|$)/i.test(o.httpMetadata?.contentType ?? '') ||
    /\.(?:png|jpe?g|webp|gif|pdf)$/i.test(o.key)));
  return {files,next:page.truncated?page.cursor:undefined,truncated:page.truncated};
}
// Operator-only helper: SELECT + bounded R2 LIST, never DELETE or metadata writes.
// No public route or new OAuth permission is introduced for this helper.
export async function previewCommandMediaRetention(env:Env,now=Date.now(),progress=false) {
  const range=previousTurkeyDay(now),jobs=[];
  const total=await env.DB.prepare(`SELECT COUNT(*) n FROM command_jobs j WHERE ${ELIGIBLE} AND NOT EXISTS (SELECT 1 FROM system_state WHERE key=?||j.id) AND NOT EXISTS (SELECT 1 FROM system_state WHERE key=?||j.id)`).bind(...values(now),PREFIX+'done:',PREFIX+'review:').first<{n:number}>();
  for(const job of await candidates(env,now,progress)) {
    const state=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(progress?PREFIX+'preview-cursor:'+range.day+':'+job.id:PREFIX+'cursor:'+job.id).first<{value:string}>();
    const page=await mediaPage(env,job,state?.value);
    jobs.push({job_id:job.id,template_id:job.template_id,job_requested_at:job.created_at,job_trt_day:range.day,
      files:page.files.map(o=>({key:o.key,size_bytes:o.size})),has_more:page.truncated,next_cursor:page.next ?? null});
  }
  return {mode:'dry_run',...range,jobs,eligible_jobs:total?.n ?? 0,has_more_jobs:(total?.n ?? 0)>jobs.length,max_jobs:JOBS,max_objects_per_job:PAGE,source_time_status:'unknown'};
}
export async function expiredCommandMediaKeys(env:Env,keys:string[]) {
  const expired=new Set<string>();
  if(!env.COMMAND_MEDIA_RETENTION_MODE || !keys.length)return expired;
  for(let i=0;i<keys.length;i+=50) {
    const chunk=keys.slice(i,i+50);
    const rows=await env.DB.prepare(`SELECT media_key FROM command_media_expirations WHERE status='deleted' AND media_key IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all<{media_key:string}>();
    for(const row of rows.results ?? [])expired.add(row.media_key);
  }
  return expired;
}
export async function retentionSealedJob(env:Env,id:string) {
  if(!env.COMMAND_MEDIA_RETENTION_MODE)return false;
  return !!await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(PREFIX+'sealed:'+id).first();
}
export async function runCommandMediaRetention(env:Env,now=Date.now()) {
  const mode=env.COMMAND_MEDIA_RETENTION_MODE;
  if(mode!=='dry_run' && mode!=='delete')return {mode:'off'};
  if(mode==='dry_run') {
    const report=await previewCommandMediaRetention(env,now,true);
    for(const job of report.jobs) {
      const key=PREFIX+'preview-job:'+report.day+':'+job.job_id;
      const old=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(key).first<{value:string}>();
      const files=old?JSON.parse(old.value).files:[];
      const combined=new Map([...files,...job.files].map((file:{key:string;size_bytes:number})=>[file.key,file]));
      await env.DB.prepare('INSERT OR REPLACE INTO system_state(key,value) VALUES (?,?)').bind(key,JSON.stringify({...job,files:[...combined.values()]})).run();
      if(job.has_more && !job.next_cursor)continue;
      await env.DB.prepare('INSERT OR REPLACE INTO system_state(key,value) VALUES (?,?)')
        .bind(job.has_more?PREFIX+'preview-cursor:'+report.day+':'+job.job_id:PREFIX+'preview-done:'+report.day+':'+job.job_id,job.next_cursor ?? report.day).run();
    }
    await env.DB.prepare('INSERT OR REPLACE INTO system_state(key,value) VALUES (?,?)').bind(PREFIX+'preview',JSON.stringify(report)).run();
    return report;
  }
  const token=crypto.randomUUID(),lock=PREFIX+'lock',at=sqlTime(now),range=previousTurkeyDay(now);
  const acquired=await env.DB.prepare(`INSERT INTO system_state(key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE system_state.updated_at<=?`)
    .bind(lock,token,at,sqlTime(now-300_000)).run();
  if(!acquired.meta.changes)return {mode:'busy'};
  let deleted=0,errors=0,bytes=0;
  try {
    for(const job of await candidates(env,now)) {
      const sealed=await env.DB.prepare(`INSERT OR IGNORE INTO system_state(key,value)
        SELECT ?,? FROM command_jobs j WHERE j.id=? AND ${ELIGIBLE}`).bind(PREFIX+'sealed:'+job.id,range.day,job.id,...values(now)).run();
      if(!sealed.meta.changes && !await retentionSealedJob(env,job.id))continue;
      if(!await eligibleJob(env,job.id,now))continue;
      const cursor=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(PREFIX+'cursor:'+job.id).first<{value:string}>();
      const unresolved=(await env.DB.prepare("SELECT media_key,size_bytes FROM command_media_expirations WHERE job_id=? AND status!='deleted' LIMIT ?")
        .bind(job.id,PAGE).all<{media_key:string;size_bytes:number}>()).results ?? [];
      let page;
      try { page=unresolved.length ? {files:unresolved.filter(r=>safeKey(r.media_key,job.id)).map(r=>({key:r.media_key,size:r.size_bytes})),next:undefined,truncated:false}
        : await mediaPage(env,job,cursor?.value); }
      catch { errors++;continue; }
      let failed=false;
      for(const file of page.files) {
        if(!await eligibleJob(env,job.id,now)) {failed=true;break;}
        await env.DB.prepare(`INSERT OR IGNORE INTO command_media_expirations(media_key,job_id,job_trt_day,status,size_bytes,planned_at)
          VALUES (?,?,?,'pending',?,?)`).bind(file.key,job.id,range.day,file.size,at).run();
        const audit=await env.DB.prepare('SELECT status,attempts FROM command_media_expirations WHERE media_key=?').bind(file.key).first<{status:string;attempts:number}>();
        if(audit?.status==='deleted')continue;
        if(!audit || audit.attempts>=3) {failed=true;errors++;await env.DB.prepare('INSERT OR REPLACE INTO system_state(key,value) VALUES (?,?)').bind(PREFIX+'review:'+job.id,'retention_delete_retry_limit').run();break;}
        await env.DB.prepare("UPDATE command_media_expirations SET attempts=attempts+1,status='pending' WHERE media_key=?").bind(file.key).run();
        try {
          await env.COMMAND_MEDIA.delete(file.key);
          await env.DB.prepare("UPDATE command_media_expirations SET status='deleted',deleted_at=?,error=NULL WHERE media_key=?").bind(at,file.key).run();
          deleted++;bytes+=file.size;
        } catch {
          failed=true;errors++;
          await env.DB.prepare("UPDATE command_media_expirations SET status='error',error='r2_delete_or_audit_failed' WHERE media_key=?").bind(file.key).run();
        }
      }
      if(failed)continue;
      if(unresolved.length)continue; // Reconcile DELETE/audit interruption before moving the R2 cursor.
      if(page.truncated && !page.next) {errors++;continue;}
      await env.DB.prepare('INSERT OR REPLACE INTO system_state(key,value) VALUES (?,?)')
        .bind(page.next?PREFIX+'cursor:'+job.id:PREFIX+'done:'+job.id,page.next ?? range.day).run();
    }
    const summary={mode:'delete',job_trt_day:range.day,deleted_objects:deleted,deleted_bytes:bytes,errors,checked_at:new Date(now).toISOString()};
    await env.DB.prepare('INSERT OR REPLACE INTO system_state(key,value) VALUES (?,?)').bind(PREFIX+'last_result',JSON.stringify(summary)).run();
    return summary;
  } finally {
    await env.DB.prepare('DELETE FROM system_state WHERE key=? AND value=?').bind(lock,token).run();
  }
}
