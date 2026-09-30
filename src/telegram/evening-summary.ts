import type { Env } from '../types';
import { istanbulDay, prepareDailySummary, type SummaryKind } from './daily-summary';

export const AUTO_SUMMARY_PREFIX = 'day-summary:auto:';
const STATE_PREFIX = 'evening_summary:';
// Borsa Istanbul Pay Piyasasi 2026 official calendar, verified 2026-09-30.
// Half days remain trading days; an unverified new year fails closed.
export const VERIFIED_2026_CALENDAR = {
  year:2026,source:'https://www.borsaistanbul.com/files/pay-piyasasi-2026-yili-tatil-tablosu.pdf',verifiedAt:'2026-09-30T00:00:00Z',
  closedDates:['2026-01-01','2026-03-20','2026-03-21','2026-03-22','2026-04-23','2026-05-01','2026-05-19','2026-05-27','2026-05-28','2026-05-29','2026-05-30','2026-07-15','2026-08-30','2026-10-29'],
};
const LEASE_MS = 120_000;
interface Run {
  day: string; chat: string; status: 'preparing_dkb'|'dkb_pending'|'completed'|'needs_attention';
  token: string; lease_until: number; dkb_pages: number; requested_at: string; updated_at: string; error?: string;
}
export function eveningWindow(now:number) {
  const local = new Date(now + 3 * 3600_000), day = istanbulDay(now).day;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return { day, weekday:local.getUTCDay(), open:minute>=20*60+30 && minute<21*60 };
}
export function eveningTradingDay(env:Env, now:number): 'open'|'closed'|'calendar_unverified' {
  const {day,weekday}=eveningWindow(now);
  if(weekday===0 || weekday===6)return 'closed';
  try {
    const c=env.EVENING_SUMMARY_CALENDAR_JSON?JSON.parse(env.EVENING_SUMMARY_CALENDAR_JSON):VERIFIED_2026_CALENDAR;
    const url=new URL(c.source);
    if(c.year!==Number(day.slice(0,4)) || !Array.isArray(c.closedDates) ||
      !/^https:$/.test(url.protocol) || !/^(www\.)?borsaistanbul\.com$/.test(url.hostname) || url.username || url.password ||
      !Number.isFinite(Date.parse(c.verifiedAt)) || Date.parse(c.verifiedAt)>now ||
      c.closedDates.some((d:unknown)=>typeof d!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !d.startsWith(String(c.year)+'-') || new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d))return 'calendar_unverified';
    return c.closedDates.includes(day)?'closed':'open';
  } catch {return 'calendar_unverified';}
}
export const summaryStateKey=(chat:string,day:string)=>STATE_PREFIX+chat+':'+day;
export const scheduledSummaryId=(chat:string,day:string,kind:SummaryKind)=>AUTO_SUMMARY_PREFIX+day+':'+chat+':'+kind;
const encode=(run:Run)=>JSON.stringify(run);
async function replace(env:Env,key:string,old:string,next:Run) {
  return !!(await env.DB.prepare('UPDATE system_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(encode(next),key,old).run()).meta.changes;
}
async function halt(env:Env,key:string,old:string,run:Run,error:string,now:number) {
  const next={...run,status:'needs_attention' as const,error,updated_at:new Date(now).toISOString()};
  // One transaction freezes unsent pages. In-flight sends are never replayed.
  await env.DB.batch([
    env.DB.prepare('UPDATE system_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(encode(next),key,old),
    env.DB.prepare(`UPDATE telegram_outbox SET status='blocked',last_error=?,lease_until=0
      WHERE id LIKE ? AND status='pending' AND EXISTS(SELECT 1 FROM system_state WHERE key=? AND value=?)`)
      .bind(error,AUTO_SUMMARY_PREFIX+run.day+':'+run.chat+':%',key,encode(next)),
  ]);
  return next;
}
async function generate(env:Env,key:string,run:Run,now:number) {
  const claimed=encode(run);
  try {
    const kind = 'dkb' as const;
    const pages=await prepareDailySummary(env,now,kind);
    if(!pages.length || pages.length>9999)throw new Error('invalid_pages');
    const end=Date.parse(run.day+'T21:00:00+03:00');
    if(Date.now()>=end || Date.now()>=run.lease_until) return halt(env,key,claimed,run,'generation_window_expired',Date.now());
    const next:Run={...run,status:'dkb_pending',lease_until:0,
      dkb_pages:pages.length,updated_at:new Date(now).toISOString()};
    const requestId=scheduledSummaryId(run.chat,run.day,kind);
    await env.DB.batch([
      env.DB.prepare('UPDATE system_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(encode(next),key,claimed),
      ...pages.map((text,index)=>env.DB.prepare(`INSERT OR IGNORE INTO telegram_outbox
        (id,source_ref,kind,payload,status,first_seen_at,published_at,available_at)
        SELECT ?,NULL,'action_reply',?,'pending',?,NULL,? WHERE EXISTS(SELECT 1 FROM system_state WHERE key=? AND value=?)`)
        .bind(requestId+':'+String(index).padStart(4,'0'),JSON.stringify({text:pages.length>1?text+`\n\nBölüm ${index+1}/${pages.length}`:text,plain:true}),new Date(now).toISOString(),now,key,encode(next))),
    ]);
    return next;
  } catch {return halt(env,key,claimed,run,'summary_preparation_failed',Date.now());}
}

export async function runEveningSummaries(env:Env,now=Date.now()) {
  if(env.EVENING_SUMMARY_ENABLED!=='true' || !env.TELEGRAM_CHAT_ID || !env.TELEGRAM_BOT_TOKEN)return {status:'disabled'};
  const {day,open}=eveningWindow(now),key=summaryStateKey(env.TELEGRAM_CHAT_ID,day);
  let row=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(key).first<{value:string}>();
  if(!row) {
    if(!open)return {status:'outside_window'};
    const trading=eveningTradingDay(env,now);if(trading!=='open')return {status:trading};
    const run:Run={day,chat:env.TELEGRAM_CHAT_ID,status:'preparing_dkb',token:crypto.randomUUID(),lease_until:now+LEASE_MS,dkb_pages:0,requested_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString()};
    const inserted=await env.DB.prepare('INSERT OR IGNORE INTO system_state(key,value) VALUES (?,?)').bind(key,encode(run)).run();
    if(inserted.meta.changes)return generate(env,key,run,now);
    row=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(key).first<{value:string}>();
  }
  if(!row)return {status:'race_lost'};
  let run:Run;
  try {run=JSON.parse(row.value);}catch{return {status:'invalid_state'};}
  if(run.day!==day || run.chat!==env.TELEGRAM_CHAT_ID)return {status:'invalid_state'};
  if(run.status==='completed' || run.status==='needs_attention')return run;
  if(run.status==='preparing_dkb') {
    if(now>=run.lease_until)return halt(env,key,row.value,run,'preparation_lease_expired',now);
    return run;
  }
  const kind:SummaryKind='dkb',expected=run.dkb_pages;
  const pages=(await env.DB.prepare('SELECT id,status,message_id,sent_at,lease_until FROM telegram_outbox WHERE id LIKE ? ORDER BY id')
    .bind(scheduledSummaryId(run.chat,day,kind)+':%').all<{id:string;status:string;message_id:number|null;sent_at:string|null;lease_until:number}>()).results ?? [];
  if(!expected || pages.length!==expected || pages.some((p,i)=>p.id!==scheduledSummaryId(run.chat,day,kind)+':'+String(i).padStart(4,'0')))
    return halt(env,key,row.value,run,'page_manifest_mismatch',now);
  if(pages.some(p=>!['pending','sending','sent'].includes(p.status) || (p.status==='sending' && p.lease_until<=now)))
    return halt(env,key,row.value,run,'delivery_failed_or_uncertain',now);
  const allSent=pages.every(p=>p.status==='sent' && p.message_id!==null && p.sent_at!==null);
  if(allSent) {
    const next:Run={...run,status:'completed',updated_at:new Date(now).toISOString()};await replace(env,key,row.value,next);return next;
  }
  if(!open)return halt(env,key,row.value,run,'delivery_window_expired',now);
  return run;
}

// SELECT only. Same owner/audience/read scope is enforced by the MCP router.
export async function getEveningDkbSummary(env:Env,day=istanbulDay().day,now=Date.now(),pageOffset=0,sourceOffset=0) {
  const base={schema_version:1,summary_id:'dkb:'+day,kind:'dkb',day,timezone:'Europe/Istanbul',read_at:new Date(now).toISOString(),source_data_at:null,
    data_scope:'registered_kap_disclosures',coverage:'Henüz taranmayan veya kayıtlarda bulunmayan KAP bildirimleri dahil değildir.'};
  if(!env.TELEGRAM_CHAT_ID)return {...base,status:'not_configured',availability:'unavailable'};
  const row=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(summaryStateKey(env.TELEGRAM_CHAT_ID,day)).first<{value:string}>();
  if(!row)return {...base,status:'not_started',availability:'pending',full_text:'',shares:[],pages:[],source_records:[],pagination_complete:false};
  let run:Run;try {run=JSON.parse(row.value);}catch{return {...base,status:'invalid_state',availability:'needs_attention'};}
  if(run.day!==day || run.chat!==env.TELEGRAM_CHAT_ID)return {...base,status:'invalid_state',availability:'needs_attention'};
  const prefix=scheduledSummaryId(env.TELEGRAM_CHAT_ID,day,'dkb');
  const pages=(await env.DB.prepare('SELECT id,status,payload,message_id,sent_at FROM telegram_outbox WHERE id LIKE ? ORDER BY id').bind(prefix+':%')
    .all<{id:string;status:string;payload:string;message_id:number|null;sent_at:string|null}>()).results ?? [];
  const manifest=run.dkb_pages>0 && pages.length===run.dkb_pages && pages.every((p,i)=>p.id===prefix+':'+String(i).padStart(4,'0'));
  const sent=manifest && pages.every(p=>p.status==='sent' && p.message_id!==null && p.sent_at!==null);
  const texts=pages.map(p=>{try {const v=JSON.parse(p.payload);return typeof v.text==='string'?v.text:null;}catch{return null;}});
  const valid=manifest && texts.every(t=>t!==null);
  const shares=new Map<string,number>();
  for(const text of texts)for(const match of (text??'').matchAll(/#([A-Z][A-Z0-9]{3,4}):\s*(\d+)/g))shares.set(match[1],Number(match[2]));
  const allShares=[...shares].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).map(([ticker,circuit_breaker_count])=>({ticker,circuit_breaker_count}));
  const {start,end}=istanbulDay(Date.parse(run.requested_at));
  const sources=(await env.DB.prepare(`SELECT disclosure_id,title,company,ticker,published_at,url,metadata_json
    FROM kap_disclosures WHERE julianday(published_at)>=julianday(?) AND julianday(published_at)<julianday(?)
    AND julianday(published_at)<=julianday(?) ORDER BY published_at,disclosure_id`)
    .bind(start,end,run.requested_at).all<{title:string;[key:string]:unknown}>()).results??[];
  const breakers=sources.filter(r=>/pay bazında devre kesici/i.test(r.title));
  const selected=pages.slice(pageOffset,pageOffset+20).map((p,i)=>({page:pageOffset+i+1,text:texts[pageOffset+i],status:p.status,message_id:p.message_id,sent_at:p.sent_at}));
  const nextPage=pageOffset+selected.length<pages.length?pageOffset+selected.length:null;
  const sourceRecords=breakers.slice(sourceOffset,sourceOffset+100);
  const nextSource=sourceOffset+sourceRecords.length<breakers.length?sourceOffset+sourceRecords.length:null;
  return {...base,status:run.status,availability:run.status==='needs_attention'||!valid?'needs_attention':sent?'available':'pending',
    generated_at:run.requested_at,expected_pages:run.dkb_pages,total_pages:pages.length,pages:selected,all_pages_sent:sent,
    full_text:selected.map(p=>p.text??'').join('\n\n'),text_truncated:false,shares:allShares,total_shares:allShares.length,shares_complete:true,shares_basis:'registered_circuit_breaker_counts',
    source_records:sourceRecords,total_source_records:breakers.length,source_records_cutoff:run.requested_at,
    page_offset:pageOffset,next_page_offset:nextPage,source_offset:sourceOffset,next_source_offset:nextSource,
    page_delivery_complete:valid,pagination_complete:valid&&nextPage===null&&nextSource===null,
    draft_evidence_state:'requires_content_review',error:run.error??(!valid?'page_manifest_or_payload_mismatch':null)};
}
