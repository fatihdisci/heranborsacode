import { parseHTML } from 'linkedom';
import type { Env } from '../types';
import { feedStatement } from '../db/feed';
import { financeNotificationCutoff, getState, setState } from '../db/state';
import { normalize } from '../notifications/rules';
import { enqueueStatement } from '../telegram/outbox';
import { fetchWithTimeout } from '../utils/http';
import { escapeTelegramHtml, sha256 } from '../utils/text';

const ROOT = 'https://spk.gov.tr';
const BASELINE_KEY = 'spk_press_baseline_v1';
const MONTHS: Record<string, number> = { OCA:1, SUB:2, MAR:3, NIS:4, MAY:5, HAZ:6, TEM:7, AGU:8, EYL:9, EKI:10, KAS:11, ARA:12 };

export interface PressEntry { title:string; url:string; publishedAt:string; }

function publicationDate(value:string):string|null {
  const match=normalize(value).match(/(\d{1,2})\s+(OCAK|SUBAT|MART|NISAN|MAYIS|HAZIRAN|TEMMUZ|AGUSTOS|EYLUL|EKIM|KASIM|ARALIK|OCA|SUB|MAR|NIS|MAY|HAZ|TEM|AGU|EYL|EKI|KAS|ARA)\s+(20\d{2})/);
  if(!match)return null;
  const month=MONTHS[match[2].slice(0,3)];
  if(!month)return null;
  // SPK supplies a date without a time. Store midnight in Istanbul.
  return new Date(Date.UTC(Number(match[3]),month-1,Number(match[1])-1,21)).toISOString();
}

export function parsePressList(html:string,year:number):PressEntry[] {
  const {document}=parseHTML(html);
  const entries=new Map<string,PressEntry>();
  for(const anchor of document.querySelectorAll('.liste > a.link[href]')) {
    const raw=anchor.getAttribute('href');
    if(!raw)continue;
    const url=new URL(raw,ROOT);
    if(url.hostname!=='spk.gov.tr'||!url.pathname.startsWith(`/duyurular/basin-duyurulari/${year}/`)||url.search)continue;
    const title=anchor.querySelector('.liste-baslik')?.textContent?.replace(/\s+/g,' ').trim();
    const publishedAt=publicationDate(anchor.querySelector('.liste-tarih')?.textContent??'');
    if(title&&publishedAt)entries.set(url.toString(),{title,url:url.toString(),publishedAt});
  }
  return [...entries.values()];
}

export function parsePressBody(html:string):string {
  const {document}=parseHTML(html);
  const root=document.querySelector('.page-content.print-container .icerik.styled-content');
  if(!root)throw new Error('SPK basın duyurusunun ana metni bulunamadı');
  root.querySelectorAll('script,style').forEach(node=>node.remove());
  const text=(root.textContent??'').replace(/Duyuruyu PDF formatında indirmek için[\s\S]*$/i,'').replace(/\s+/g,' ').trim();
  if(text.length<30||text.length>100_000)throw new Error('SPK basın duyurusu ana metni geçersiz');
  return text;
}

export function isFundPress(title:string,body:string):boolean {
  const heading=normalize(title),text=normalize(`${title} ${body}`);
  return /FON|PORTFOY|TEFAS/.test(heading)||
    /FON|PORTFOY|TEFAS/.test(text)&&/TASFIYE|TEMERRUT|ODEME|IADE|ALIM SATIM|ISLEMLERIN DURDURUL|REHBER/.test(text);
}

async function fetchPage(url:string):Promise<string> {
  const response=await fetchWithTimeout(url,{headers:{accept:'text/html', 'user-agent':'Mozilla/5.0 (compatible; HeranBorsa/1.0)'},cache:'no-store'});
  if(!response.ok)throw new Error(`SPK basın duyuruları HTTP ${response.status}`);
  const html=await response.text();
  if(html.length>3_000_000)throw new Error('SPK basın duyurusu sayfası çok büyük');
  return html;
}

export async function pollSPKPress(env:Env):Promise<void> {
  const year=new Date(Date.now()+3*3_600_000).getUTCFullYear();
  const entries=parsePressList(await fetchPage(`${ROOT}/duyurular/basin-duyurulari/${year}`),year);
  if(!entries.length)throw new Error('SPK basın duyuruları listesi ayrıştırılamadı');
  const keys=await Promise.all(entries.map(entry=>sha256(entry.url).then(hash=>`spk_press_seen:${hash}`)));
  if(!await getState(env,BASELINE_KEY)) {
    await env.DB.batch([
      ...keys.map(key=>env.DB.prepare("INSERT OR IGNORE INTO system_state(key,value) VALUES (?,'1')").bind(key)),
      env.DB.prepare("INSERT OR IGNORE INTO system_state(key,value) VALUES (?,?)").bind(BASELINE_KEY,new Date().toISOString()),
    ]);
    return;
  }
  const known=new Set((await env.DB.prepare("SELECT key FROM system_state WHERE key LIKE 'spk_press_seen:%'").all<{key:string}>()).results?.map(row=>row.key)??[]);
  const cutoff=await financeNotificationCutoff(env);
  let failed=0;
  for(const [index,entry] of entries.entries()) {
    const key=keys[index];
    if(known.has(key))continue;
    try {
      const body=parsePressBody(await fetchPage(entry.url));
      if(!isFundPress(entry.title,body)) { await setState(env,key,'1');continue; }
      const seen=new Date().toISOString();
      const slug=new URL(entry.url).pathname.split('/').at(-1)!;
      const ref=`spk:press:${year}:${slug}`;
      const notify=(cutoff===null||Date.parse(entry.publishedAt)+86_400_000>cutoff)&&
        Date.parse(entry.publishedAt)+86_400_000>Date.now()-86_400_000;
      const text=`🔴 <b>SPK · Fon duyurusu</b>\n\n<b>${escapeTelegramHtml(entry.title)}</b>\n\nResmî açıklama yayımlandı. Ayrıntılar için asıl kaynağı aç.`;
      await env.DB.batch([
        feedStatement(env,{type:'spk',source:'SPK Basın Duyurusu',source_ref:ref,title:entry.title,body,url:entry.url,tickers_json:'[]',published_at:entry.publishedAt}),
        ...(notify?[enqueueStatement(env,ref,'priority_message',{text,button:{text:'🔗 SPK açıklamasını aç',url:entry.url}},entry.publishedAt,seen)]:[]),
        env.DB.prepare("INSERT OR IGNORE INTO system_state(key,value) VALUES (?,'1')").bind(key),
      ]);
    } catch(error) {
      failed++;
      console.warn('SPK basın duyurusu işlenemedi',{url:entry.url,error:error instanceof Error?error.message:String(error)});
    }
  }
  if(failed)throw new Error(`${failed} SPK basın duyurusu işlenemedi`);
}
