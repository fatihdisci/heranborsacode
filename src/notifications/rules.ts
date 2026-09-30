import { isImportantPublicDisclosure } from "../kap/importance";
import { shareActivity } from '../kap/share-activity';
import type {Env,FeedItem} from '../types';
import {indexTier,type IndexMembership} from './indices';
export const TOPICS={dividend:'Temettü',buyback:'Geri alım',financials:'Finansal sonuçlar',capital:'Sermaye işlemleri',contract:'İş ilişkisi / sözleşme',ownership:'Pay alım / satım',breaker:'Devre kesici',other:'Diğer'} as const;
export type Topic=keyof typeof TOPICS;
export interface WatchRule {ticker:string; mode:'important'|'all'|'topics'; topics:Topic[];}
export interface Preferences {version:1;watchlist:WatchRule[];otherCompanies:'all'|'topics'|'off';otherTopics:Topic[];funds:'instant'|'digest'|'off';digestHour:number;priorityIndices:boolean;excludedTitles:string[];}
export const DEFAULTS:Preferences={version:1,watchlist:[],otherCompanies:'all',otherTopics:['dividend','buyback'],funds:'instant',digestHour:19,priorityIndices:true,excludedTitles:['İhraç belgesi','Fon ihraç sözleşmesi','Kredi kullanımı','İç Tüzük','Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faizsiz)','Kurumsal Yönetim Bilgi Formu (Güncelleme) - Yönetim Kurulu-2']};
export const normalize=(text:string)=>text.toLocaleUpperCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'I');
export const isMutedKapTitle=(title:string):boolean=>{
  const compact=normalize(title).replace(/[^A-Z0-9]/g,'');
  return /ICTUZU[KG]|PAYDISINDASERMAYEPIYASASIARACIISLEMLERINEILISKINBILDIRIMFAIZSIZ|KURUMSALYONETIMBILGIFORMUGUNCELLEMEYONETIMKURULU2/.test(compact);
};
export const isCriticalFundDisclosure=(item:Pick<FeedItem,'title'|'body'>):boolean=>{
  const title=normalize(item.title),context=normalize(`${item.title} ${item.body??''}`);
  return /FON|PORTFOY|TEFAS/.test(context)&&/TEMERRUT|TASFIYE|ISLEMLERIN DURDURUL|ALIM SATIM ISLEMLERININ DURDURUL|KATILMA PAYI IADE|ODEME/.test(title);
};
export function symbols(item:Pick<FeedItem,'tickers_json'> & {subject_tickers_json?:string|null}):string[] {try {const data=JSON.parse(item.subject_tickers_json??item.tickers_json??'[]');return Array.isArray(data)?data.filter(x=>typeof x==='string'&&/^[A-Z][A-Z0-9]{3,4}$/.test(x)):[];}catch{return [];}}
export function classify(item:Pick<FeedItem,'title'|'body'|'tickers_json'>):{fund:boolean;topics:Topic[]} {
  const title=normalize(item.title), text=normalize(`${item.title} ${item.body??''}`);
  const topics:Topic[]=[];
  if(/TEMETTU|KAR PAYI DAGITIM/.test(title))topics.push('dividend');
  if(/GERI AL|GERI SAT|GERI ALINAN PAY/.test(title))topics.push('buyback');
  if(/FINANSAL (RAPOR|TABLO|SONUC)|FAALIYET RAPOR/.test(title))topics.push('financials');
  if(/SERMAYE ART|SERMAYE AZ|BEDELLI|BEDELSIZ/.test(title))topics.push('capital');
  if(/IS ILISKISI|SOZLESME|IHALE|SIPARIS/.test(title))topics.push('contract');
  if(/PAY ALIM|PAY SATIM/.test(title)&&!topics.includes('buyback'))topics.push('ownership');
  if(/DEVRE KESICI/.test(title))topics.push('breaker');
  if(!topics.length)topics.push('other');
  return {fund:!symbols(item).length&&/FON|PORTFOY|VARLIK YONETIM/.test(text),topics};
}
const preferenceKey=(env:Env)=>`notification_preferences:v1:${env.TELEGRAM_CHAT_ID??'default'}`;
export function parsePreferences(value:unknown):Preferences {
  const fail=():never=>{throw new Error('Geçersiz bildirim kuralı');};
  if(!value||typeof value!=='object')return fail();
  const v=value as Preferences;
  const topics=(x:unknown):x is Topic[]=>Array.isArray(x)&&x.length<=Object.keys(TOPICS).length&&x.every(t=>typeof t==='string'&&Object.hasOwn(TOPICS,t))&&new Set(x).size===x.length;
  if(v.version!==1||!Array.isArray(v.watchlist)||v.watchlist.length>100||!['all','topics','off'].includes(v.otherCompanies)||!topics(v.otherTopics)||!['instant','digest','off'].includes(v.funds)||!Number.isInteger(v.digestHour)||v.digestHour<0||v.digestHour>23||typeof v.priorityIndices!=='boolean'||!Array.isArray(v.excludedTitles)||v.excludedTitles.length>20||v.excludedTitles.some(t=>typeof t!=='string'||!t.trim()||t.length>100))return fail();
  const watchlist=v.watchlist.map(w=>{
    if(!w||typeof w.ticker!=='string'||!/^[A-Z][A-Z0-9]{3,4}$/.test(w.ticker)||!['all','important','topics'].includes(w.mode)||!topics(w.topics)||(w.mode==='topics'&&!w.topics.length))return fail();
    return {ticker:w.ticker,mode:w.mode,topics:w.topics};
  });
  if(new Set(watchlist.map(w=>w.ticker)).size!==watchlist.length||(v.otherCompanies==='topics'&&!v.otherTopics.length))return fail();
  return {version:1,watchlist,otherCompanies:v.otherCompanies,otherTopics:v.otherTopics,funds:v.funds,digestHour:v.digestHour,priorityIndices:v.priorityIndices,excludedTitles:v.excludedTitles.map(t=>t.trim())};
}
export async function getPreferences(env:Env):Promise<Preferences> {
  const row=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(preferenceKey(env)).first<{value:string}>();
  return row?parsePreferences(JSON.parse(row.value)):structuredClone(DEFAULTS);
}
export async function savePreferences(env:Env,value:unknown):Promise<Preferences> {
  const settings=parsePreferences(value);
  const previous=await getPreferences(env);
  const writes=[env.DB.prepare('INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').bind(preferenceKey(env),JSON.stringify(settings))];
  if(settings.funds!=='digest')writes.push(env.DB.prepare("UPDATE telegram_outbox SET status=?,available_at=?,last_error=? WHERE status='digest' AND source_ref LIKE 'kap:%'").bind(settings.funds==='off'?'filtered':'pending',Date.now(),settings.funds==='off'?'Fon bildirimleri kapalı':null));
  else if(previous.digestHour!==settings.digestHour) {
    const now=Date.now(),local=new Date(now+3*3600_000);
    let due=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),settings.digestHour-3);if(due<=now)due+=86400_000;
    writes.push(env.DB.prepare("UPDATE telegram_outbox SET available_at=? WHERE status='digest' AND source_ref LIKE 'kap:%'").bind(due));
  }
  await env.DB.batch(writes);return settings;
}
export function decide(item:FeedItem,p:Preferences,indices:IndexMembership):{action:'instant'|'digest'|'off';reason:string;tier:30|100|null;watched:boolean} {
  const codes=symbols(item),tier=indexTier(codes,indices),rules=p.watchlist.filter(w=>codes.includes(w.ticker)),watched=rules.length>0;
  const result=(action:'instant'|'digest'|'off',reason:string)=>({action,reason,tier,watched});
  if(item.type!=='kap')return result('instant','Haber / SPK');
  if(shareActivity(item.title))return result('instant','Pay geri alım / alım / satım bildirimi');
  if(isMutedKapTitle(item.title))return result('off','Susturulan KAP başlığı');
  if(p.excludedTitles.some(term=>normalize(item.title).includes(normalize(term))))return result('off','Hariç tutulan başlık');
  if(isCriticalFundDisclosure(item))return result('instant','Kritik fon gelişmesi');
  const {fund,topics}=classify(item);
  if(fund)return result(p.funds,'Fon / portföy kuralı');
  if(watched)return result(rules.some(w=>w.mode==='all'||w.mode==='important'&&isImportantPublicDisclosure({title:item.title,company:item.body,codes},p.watchlist.map(w=>w.ticker))||w.mode==='topics'&&w.topics.some(t=>topics.includes(t)))?'instant':'off','Takip listesi');
  const relatedCodes=symbols({tickers_json:item.tickers_json});
  const marketwide=!codes.length&&relatedCodes.length>1&&!/PAY ALIM BİLDİRİMİ|PAY SATIM BİLDİRİMİ/i.test(item.title);
  const important=isImportantPublicDisclosure({title:item.title,company:item.body,codes},p.priorityIndices?indices.bist100:[])||
    marketwide&&isImportantPublicDisclosure({title:item.title,company:item.body,codes:relatedCodes},[]);
  if(tier&&p.priorityIndices&&important)return result('instant','BIST önceliği');
  return result(p.otherCompanies==='all'&&important||(p.otherCompanies==='topics'&&p.otherTopics.some(t=>topics.includes(t)))?'instant':'off','Diğer şirketler');
}
export function markers(codes:string[],p:Preferences,indices:IndexMembership):string {
  const tier=indexTier(codes,indices);
  return [tier===30?'⭐ BIST 30':tier===100?'🔵 BIST 100':'',p.watchlist.some(w=>codes.includes(w.ticker))?'🔔 Takip listem':''].filter(Boolean).join(' · ');
}
