import type { Env } from '../types';
import snapshot from './index-snapshot.json';
import { fetchWithTimeout } from '../utils/http';
export interface IndexMembership { source:string; checkedAt:string; bist30:string[]; bist100:string[]; }
const KEY='notification_index_membership_v1';
export function parseIndices(html:string, now=new Date().toISOString()):IndexMembership {
  const decoded=html.replace(/\\"/g,'"');
  const codes=(code:string,count:number)=>{
    const match=decoded.match(new RegExp('"code":"'+code+'","content":(\\[.*?\\])','s'));
    if(!match)throw new Error('KAP endeks verisi bulunamadı');
    const rows=JSON.parse(match[1]);
    if(!Array.isArray(rows))throw new Error('KAP endeks biçimi geçersiz');
    const values=[...new Set<string>(rows.map(row=>row.stockCode))].sort();
    if(values.length!==count || values.some(code=>typeof code!=='string'||!/^[A-Z][A-Z0-9]{3,4}$/.test(code)))throw new Error('KAP endeks üye sayısı/kodları doğrulanamadı');
    return values;
  };
  const result={source:snapshot.source,checkedAt:now,bist30:codes('XU030',30),bist100:codes('XU100',100)};
  if(result.bist30.some(code=>!result.bist100.includes(code)))throw new Error('BIST 30/100 üyelikleri tutarsız');
  return result;
}
export async function getIndices(env:Env):Promise<IndexMembership> {
  const row=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(KEY).first<{value:string}>();
  return row ? JSON.parse(row.value) : snapshot;
}
export async function refreshIndices(env:Env, now=Date.now()):Promise<void> {
  const key=KEY+':attempt';
  const attempt=await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(key).first<{value:string}>();
  if(now-Number(attempt?.value??0)<24*60*60_000)return;
  await env.DB.prepare('INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,String(now)).run();
  try {
    const response=await fetchWithTimeout(snapshot.source,{headers:{accept:'text/html','user-agent':'Mozilla/5.0 (compatible; HeranBorsa/1.0)'}},25000);
    if(!response.ok)throw new Error(`KAP endeks HTTP ${response.status}`);
    const html=await response.text();if(html.length>3_000_000)throw new Error('KAP endeks sayfası çok büyük');
    const data=parseIndices(html,new Date(now).toISOString());
    await env.DB.prepare('INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(KEY,JSON.stringify(data)).run();
  } catch(error) { console.error('Endeks listesi güncellenemedi; son doğrulanan liste korunuyor', {error:error instanceof Error?error.message:'unknown'}); }
}
export function indexTier(codes:string[],indices:IndexMembership):30|100|null {
  return codes.some(code=>indices.bist30.includes(code))?30:codes.some(code=>indices.bist100.includes(code))?100:null;
}
