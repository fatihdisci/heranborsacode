import type { Env } from "../types";
import { feedStatement, insertFeed } from "../db/feed";
import { enqueueStatement } from "../telegram/outbox";
import { fetchWithTimeout } from "../utils/http";
import { decodeEntities, escapeTelegramHtml } from "../utils/text";
import { getState, setState } from "../db/state";

const SPK_URL = "https://spk.gov.tr/spk-bultenleri/2026-yili-spk-bultenleri";
interface Bulletin { number: string; date: string | null; pdfUrl: string; }

function clean(value: string): string { return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()); }

function turkishPublicationDate(value: string): string | null {
  const match = value.match(/Yayımlanma\s*:\s*(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(20\d{2})/i);
  if (!match) return null;
  const months: Record<string, string> = { ocak: "01", şubat: "02", mart: "03", nisan: "04", mayıs: "05", haziran: "06", temmuz: "07", ağustos: "08", eylül: "09", ekim: "10", kasım: "11", aralık: "12" };
  const month = months[match[2].toLocaleLowerCase("tr-TR")];
  return month ? `${match[1].padStart(2, "0")}.${month}.${match[3]}` : null;
}

function recentBulletinDate(value: string | null): boolean {
  if (!value) return false;
  const match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1);
  return date.getTime() >= start;
}

function bulletinPublishedAt(value: string | null): string | null {
  const match = value?.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return null;
  // SPK bulletins are date-only; place them at midnight in Istanbul.
  return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]) - 1, 21)).toISOString();
}

export function parseBulletins(html: string, baseUrl = SPK_URL): Bulletin[] {
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const unique = new Map<string, Bulletin>();
  for (const link of links) {
    const label = clean(link[2]);
    const surrounding = html.slice(Math.max(0, link.index! - 450), link.index! + link[0].length + 100);
    const number = (label.match(/20\d{2}\s*\/\s*\d+/) ?? surrounding.match(/20\d{2}\s*\/\s*\d+/))?.[0].replace(/\s/g, "") ?? null;
    if (!number) continue;
    const date = turkishPublicationDate(clean(surrounding)) ?? (surrounding.match(/\b\d{1,2}[./-]\d{1,2}[./-]20\d{2}\b/) ?? [])[0] ?? null;
    unique.set(number, { number, date, pdfUrl: new URL(link[1], baseUrl).toString() });
  }
  return [...unique.values()].sort((a, b) => a.number.localeCompare(b.number, "tr"));
}

export async function pollSPK(env: Env): Promise<void> {
  const response = await fetchWithTimeout(SPK_URL, { headers: { "user-agent": "HeranBorsa/0.1 (+Cloudflare Worker)" } });
  if (!response.ok) throw new Error(`SPK HTTP ${response.status}`);
  const bulletins = parseBulletins(await response.text());
  if (!bulletins.length) throw new Error("SPK page had no parseable PDF bulletins");
  const historyDatesInitialized = await getState(env, "spk_history_dates_v2");
  if (!historyDatesInitialized) {
    for (const bulletin of bulletins) {
      await env.DB.prepare("INSERT INTO spk_bulletins(bulletin_number, bulletin_date, pdf_url, telegram_status) VALUES (?, ?, ?, 'baseline') ON CONFLICT(bulletin_number) DO UPDATE SET bulletin_date=excluded.bulletin_date,pdf_url=excluded.pdf_url").bind(bulletin.number, bulletin.date, bulletin.pdfUrl).run();
      await insertFeed(env, { type: "spk", source: "SPK", source_ref: `spk:${bulletin.number}`, title: `SPK Bülteni: ${bulletin.number}`, body: bulletin.date ? `Tarih: ${bulletin.date}` : null, url: bulletin.pdfUrl, tickers_json: "[]", published_at: bulletinPublishedAt(bulletin.date) });
      await env.DB.prepare("UPDATE feed_items SET body=?,published_at=? WHERE source_ref=?").bind(bulletin.date ? `Tarih: ${bulletin.date}` : null, bulletinPublishedAt(bulletin.date), `spk:${bulletin.number}`).run();
    }
    await setState(env, "spk_history_initialized", "1");
    await setState(env, "spk_history_dates_v2", "1");
  }
  const initialized = await getState(env, "spk_baseline_initialized");
  if (!initialized) {
    const initial = bulletins.filter(bulletin => recentBulletinDate(bulletin.date));
    for (const bulletin of initial) {
      await env.DB.prepare("INSERT OR IGNORE INTO spk_bulletins(bulletin_number, bulletin_date, pdf_url, telegram_status) VALUES (?, ?, ?, 'baseline')").bind(bulletin.number, bulletin.date, bulletin.pdfUrl).run();
      await insertFeed(env, { type: "spk", source: "SPK", source_ref: `spk:${bulletin.number}`, title: `SPK Bülteni: ${bulletin.number}`, body: bulletin.date ? `Tarih: ${bulletin.date}` : null, url: bulletin.pdfUrl, tickers_json: "[]", published_at: bulletinPublishedAt(bulletin.date) });
    }
    await setState(env, "spk_baseline_initialized", "1");
    console.info("SPK baseline initialized", { bulletins: initial.length });
    return;
  }
  for (const bulletin of bulletins) {
    const known = await env.DB.prepare("SELECT bulletin_number FROM spk_bulletins WHERE bulletin_number = ?").bind(bulletin.number).first();
    if (known) continue;
    const ref = `spk:${bulletin.number}`;
    const publishedAt = bulletinPublishedAt(bulletin.date);
    const seen = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO spk_bulletins(bulletin_number,bulletin_date,pdf_url,telegram_status,first_seen_at) VALUES (?,?,?,'pending',?)").bind(bulletin.number,bulletin.date,bulletin.pdfUrl,seen),
      feedStatement(env,{type:"spk",source:"SPK",source_ref:ref,title:`SPK Bülteni: ${bulletin.number}`,body:bulletin.date ? `Tarih: ${bulletin.date}` : null,url:bulletin.pdfUrl,tickers_json:"[]",published_at:publishedAt}),
      enqueueStatement(env,ref,"document",{document:{url:bulletin.pdfUrl,filename:`Yeni SPK Bülteni: ${bulletin.number}${bulletin.date ? " · "+bulletin.date : ""}`}},publishedAt,seen),
    ]);
  }
}
