import type { Env } from "../types";
import { insertFeed } from "../db/feed";
import { sendMessage } from "../telegram/client";
import { fetchWithTimeout } from "../utils/http";
import { escapeTelegramHtml, sha256 } from "../utils/text";
import { BIST50 } from "./bist50";

export interface KapListItem { disclosureIndex: string; disclosureType: string; disclosureClass: string; title: string; fundId: string | null; fundCode: string | null; }
interface Detail { senderTitle?: string; senderExchCodes?: unknown; disclosureType?: string; disclosureClass?: string; subject?: { tr?: string }; summary?: { tr?: string }; time?: string; link?: string; relatedStocks?: unknown; }
interface Pending { disclosure_index: string; disclosure_type: string | null; disclosure_class: string | null; title: string | null; is_fund: number; }

export function normalizeKapList(value: unknown): KapListItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.disclosureIndex !== "string") return [];
    return [{ disclosureIndex: r.disclosureIndex, disclosureType: typeof r.disclosureType === "string" ? r.disclosureType : "", disclosureClass: typeof r.disclosureClass === "string" ? r.disclosureClass : "", title: typeof r.title === "string" ? r.title : "", fundId: typeof r.fundId === "string" ? r.fundId : null, fundCode: typeof r.fundCode === "string" ? r.fundCode : null }];
  });
}

function relevant(type: string, klass: string, title: string, fund = false): boolean {
  const all = `${type} ${klass} ${title}`.toLocaleUpperCase("tr-TR");
  if (fund || /\bFON\b/.test(all)) return true;
  return ["ODA", "CA", "FR"].some(x => `${type} ${klass}`.includes(x)) || (`${type} ${klass}`.includes("DG") && /BORSA|SERMAYE|BİRLEŞ|BIRLES|SATIN AL|PAY ALIM|PAY SATIM|SÖZLEŞ|SOZLES|TEMETT|FİNANSAL|FINANSAL/.test(all));
}
function symbols(value: unknown): string[] { return !Array.isArray(value) ? [] : value.flatMap(v => typeof v === "string" ? [v] : v && typeof v === "object" && typeof (v as { code?: unknown }).code === "string" ? [(v as { code: string }).code] : []).map(v => v.trim().toUpperCase()).filter(Boolean); }
async function kap(env: Env, path: string): Promise<Response> { return fetchWithTimeout(`${env.MKK_API_BASE_URL!.replace(/\/$/, "")}${path}`, { headers: { accept: "application/json", authorization: `Basic ${btoa(`${env.MKK_API_KEY!}:${env.MKK_API_SECRET!}`)}` } }); }

async function queue(env: Env, from: string): Promise<void> {
  const response = await kap(env, `/disclosures?${new URLSearchParams({ disclosureIndex: from })}`);
  if (!response.ok) throw new Error(`KAP disclosures HTTP ${response.status}`);
  const list = normalizeKapList(await response.json()); let highest = Number(from) - 1;
  for (const item of list) { const isFund=Boolean(item.fundId || item.fundCode); highest = Math.max(highest, Number(item.disclosureIndex)); if (relevant(item.disclosureType, item.disclosureClass, item.title, isFund)) await env.DB.prepare("INSERT OR IGNORE INTO kap_pending(disclosure_index,disclosure_type,disclosure_class,title,is_fund) VALUES (?,?,?,?,?)").bind(item.disclosureIndex,item.disclosureType,item.disclosureClass,item.title,isFund ? 1 : 0).run(); }
  if (highest >= Number(from)) await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('kap_next_index',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(String(highest + 1)).run();
}
async function process(env: Env, silent = false): Promise<void> {
  const rows = await env.DB.prepare("SELECT * FROM kap_pending ORDER BY CAST(disclosure_index AS INTEGER) LIMIT 5").all<Pending>();
  for (const row of rows.results ?? []) {
    const response = await kap(env, `/disclosureDetail/${encodeURIComponent(row.disclosure_index)}?fileType=html`); if (!response.ok) throw new Error(`KAP disclosureDetail HTTP ${response.status}`);
    const d = await response.json<Detail>(), codes = [...new Set([...symbols(d.senderExchCodes),...symbols(d.relatedStocks)])], title = d.subject?.tr || d.summary?.tr || row.title || "KAP bildirimi", type = d.disclosureType || row.disclosure_type || "", klass = d.disclosureClass || row.disclosure_class || "";
    await env.DB.prepare("DELETE FROM kap_pending WHERE disclosure_index=?").bind(row.disclosure_index).run();
    if (!relevant(type,klass,title,Boolean(row.is_fund)) || (!row.is_fund && /PAY ALIM|PAY SATIM/i.test(title) && !codes.some(x => BIST50.has(x)))) continue;
    const url=d.link || `https://www.kap.org.tr/tr/Bildirim/${row.disclosure_index}`, write=await env.DB.prepare("INSERT OR IGNORE INTO kap_disclosures(disclosure_id,company,ticker,title,disclosure_type,published_at,url,metadata_json,content_hash) VALUES (?,?,?,?,?,?,?,?,?)").bind(row.disclosure_index,d.senderTitle??null,codes[0]??null,title,type||klass,d.time??null,url,JSON.stringify(d),await sha256(`${row.disclosure_index}|${title}|${url}`)).run();
    if (!write.meta.changes) continue;
    await insertFeed(env,{type:"kap",source:"KAP",source_ref:`kap:${row.disclosure_index}`,title,body:d.senderTitle??null,url,tickers_json:JSON.stringify(codes),published_at:d.time??null});
    if (silent) {
      await env.DB.prepare("UPDATE kap_disclosures SET telegram_status='baseline' WHERE disclosure_id=?").bind(row.disclosure_index).run();
      continue;
    }
    try { await sendMessage(env,`${codes[0]?`🏢 <b>#${escapeTelegramHtml(codes[0])}</b>`:"🏢 <b>KAP</b>"}\nKAP bildirimi\n\n${escapeTelegramHtml(title)}${d.time?`\n${escapeTelegramHtml(d.time)}`:""}`,{text:"🔗 KAP'ta Aç",url}); await env.DB.prepare("UPDATE kap_disclosures SET telegram_status='sent',telegram_sent_at=CURRENT_TIMESTAMP WHERE disclosure_id=?").bind(row.disclosure_index).run(); } catch (e) { console.warn("KAP telegram delivery failed",{id:row.disclosure_index,error:e instanceof Error?e.message:String(e)}); }
  }
}
export async function pollKAP(env: Env): Promise<void> {
  if (!env.MKK_API_BASE_URL || !env.MKK_API_KEY || !env.MKK_API_SECRET) return;
  const state=await env.DB.prepare("SELECT value FROM system_state WHERE key='kap_next_index'").first<{value:string}>();
  if (!state) { const r=await kap(env,"/lastDisclosureIndex"); if (!r.ok) throw new Error(`KAP lastDisclosureIndex HTTP ${r.status}`); const p=await r.json<{lastDisclosureIndex?:string}>(); if (!p.lastDisclosureIndex || !/^\d+$/.test(p.lastDisclosureIndex)) throw new Error("KAP returned invalid lastDisclosureIndex"); await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('kap_next_index',?)").bind(String(Number(p.lastDisclosureIndex)+1)).run(); return; }
  await queue(env,state.value); await process(env);
}
