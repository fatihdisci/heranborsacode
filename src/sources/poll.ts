import type { Env } from '../types';
import type { Source } from './registry';
import { parseRss } from '../rss/parser';
import { newsFingerprint } from '../rss/dedupe';
import { classify } from './filter';
import { parseResets } from './resets';
import { pageCandidates } from './pages';
import { allowedSourceUrl } from './hosts';
import { fetchWithTimeout } from '../utils/http';
import { escapeTelegramHtml, normalizeUrl, sha256 } from '../utils/text';
import { enqueueStatement } from '../telegram/outbox';

interface Candidate { id?:string; title:string; summary:string; url:string; publishedAt:string|null; resetType?:string; }
export function recent(value:string|null, now=Date.now()):boolean {
  if (!value) return true;
  const date=Date.parse(value);
  return !Number.isNaN(date) && date>=now-48*3600_000 && date<=now+3600_000;
}
export function notificationText(source:Source,item:Candidate):string {
  const icon=source.category==='resets'?'🔄':source.category==='claude'?'🟣':'🤖';
  const summary=item.summary.trim().slice(0,500);
  return `${icon} <b>${escapeTelegramHtml(source.name)}</b>\n<b>${escapeTelegramHtml(item.title)}</b>${summary && summary!==item.title ? `\n\n${escapeTelegramHtml(summary)}` : ''}${source.attribution ? `\n\nKaynak: ${escapeTelegramHtml(source.attribution.label)}` : ''}`;
}
export async function pollSource(env:Env,source:Source):Promise<void> {
  const baselineKey=`ai_baseline:${source.id}`;
  const baseline=!(await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(baselineKey).first());
  try {
    const headers={accept:source.kind==='json'?'application/json':'application/rss+xml,application/atom+xml,application/xml,text/xml','user-agent':'VibeRadar/1.0 (+AI news reader)'};
    const response=await fetchWithTimeout(source.url,{headers,cache:'no-store'},20_000);
    if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);
    let candidates:Candidate[];
    if (source.kind==='json') {
      const resets=parseResets(await response.json());
      // Status is read independently for health and scheduled reset context.
      const statusResponse=await fetchWithTimeout('https://codex-resets.com/api/v1/status',{headers,cache:'no-store'},20_000);
      if (!statusResponse.ok) throw new Error(`Codex Resets status HTTP ${statusResponse.status}`);
      const status=await statusResponse.json();
      await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('codex_resets_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(status)).run();
      candidates=resets.map(reset=>({id:reset.id,title:`Codex kullanım limiti sıfırlaması (${reset.resetType})`,summary:reset.text,url:reset.url,publishedAt:reset.announcedAt,resetType:reset.resetType}));
    } else if (source.kind==='html' || source.kind==='sitemap') {
      candidates=await pageCandidates(source,await response.text());
    } else {
      const xml=await response.text();
      if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error(`${source.name}: invalid feed`);
      candidates=parseRss(xml).map(row=>({title:row.title,summary:row.description??'',url:row.url,publishedAt:row.publishedAt}));
    }
    for (const item of candidates) {
      if (!recent(item.publishedAt) || !allowedSourceUrl(item.url)) continue;
      const decision=classify(source,item.title,item.summary);
      if (decision.priority==='ignore') continue;
      const normalized=normalizeUrl(item.url);
      const hash=await sha256(source.category==='resets' ? `reset:${item.id}` : newsFingerprint({title:item.title,summary:item.summary.slice(0,700)}));
      const priorUrl=await env.DB.prepare('SELECT content_hash FROM ai_source_items WHERE normalized_url=?').bind(normalized).first<{content_hash:string}>();
      const storedUrl=priorUrl && priorUrl.content_hash!==hash ? `${normalized}#revision=${hash}` : normalized;
      const ref=`ai:${source.category==='resets' ? `reset:${item.id}` : hash}`;
      const seen=new Date().toISOString();
      const metadata=JSON.stringify({sourceId:source.id,classification:decision.classification,attribution:source.attribution??null,resetType:item.resetType??null});
      const claim=await env.DB.prepare('INSERT OR IGNORE INTO ai_source_items(source_ref,source_id,normalized_url,content_hash) VALUES (?,?,?,?)').bind(ref,source.id,storedUrl,hash).run();
      if (!claim.meta.changes) {
        const owned=await env.DB.prepare('SELECT source_ref FROM ai_source_items WHERE source_ref=?').bind(ref).first();
        const fed=await env.DB.prepare('SELECT id FROM feed_items WHERE source_ref=?').bind(ref).first();
        if (!owned || fed) continue;
      }
      const statements=[env.DB.prepare(`INSERT OR IGNORE INTO feed_items(type,source,source_ref,title,body,url,tickers_json,published_at,category,priority,metadata_json)
          VALUES ('news',?,?,?,?,?,'[]',?,?,?,?)`).bind(source.name,ref,item.title,item.summary.slice(0,700)||null,item.url,item.publishedAt,source.category,decision.priority,metadata)];
      if (!baseline && decision.priority==='high') statements.push(enqueueStatement(env,ref,'message',{text:notificationText(source,item),button:{text:source.category==='resets'?'Codex Resets':'Kaynağı aç',url:source.attribution?.url??item.url}},item.publishedAt,seen));
      await env.DB.batch(statements);
    }
    await env.DB.prepare("INSERT INTO system_state(key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'").bind(baselineKey).run();
    await env.DB.prepare('INSERT INTO feed_sources(url,name,last_success_at,last_error) VALUES (?,?,CURRENT_TIMESTAMP,NULL) ON CONFLICT(url) DO UPDATE SET name=excluded.name,last_success_at=CURRENT_TIMESTAMP,last_error=NULL').bind(source.url,source.name).run();
  } catch(error) {
    const message=error instanceof Error?error.message:String(error);
    await env.DB.prepare('INSERT INTO feed_sources(url,name,last_error) VALUES (?,?,?) ON CONFLICT(url) DO UPDATE SET last_error=excluded.last_error').bind(source.url,source.name,message.slice(0,400)).run();
    throw error;
  }
}
