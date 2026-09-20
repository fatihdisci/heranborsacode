import type { Env } from "../types";
import { insertFeed } from "../db/feed";
import { sendDocument, sendMessage } from "../telegram/client";
import { fetchWithTimeout } from "../utils/http";
import { escapeTelegramHtml } from "../utils/text";
import { getState, setState } from "../db/state";

const SPK_URL = "https://spk.gov.tr/spk-bultenleri/2026-yili-spk-bultenleri";
interface Bulletin { number: string; date: string | null; pdfUrl: string; }

function clean(value: string): string { return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }

export function parseBulletins(html: string, baseUrl = SPK_URL): Bulletin[] {
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const unique = new Map<string, Bulletin>();
  for (const link of links) {
    const label = clean(link[2]);
    const surrounding = html.slice(Math.max(0, link.index! - 450), link.index! + link[0].length + 100);
    const number = (label.match(/20\d{2}\s*\/\s*\d+/) ?? surrounding.match(/20\d{2}\s*\/\s*\d+/))?.[0].replace(/\s/g, "") ?? null;
    if (!number) continue;
    const date = (surrounding.match(/\b\d{1,2}[./-]\d{1,2}[./-]20\d{2}\b/) ?? [])[0] ?? null;
    unique.set(number, { number, date, pdfUrl: new URL(link[1], baseUrl).toString() });
  }
  return [...unique.values()].sort((a, b) => a.number.localeCompare(b.number, "tr"));
}

export async function pollSPK(env: Env): Promise<void> {
  const response = await fetchWithTimeout(SPK_URL, { headers: { "user-agent": "HeranBorsa/0.1 (+Cloudflare Worker)" } });
  if (!response.ok) throw new Error(`SPK HTTP ${response.status}`);
  const bulletins = parseBulletins(await response.text());
  if (!bulletins.length) throw new Error("SPK page had no parseable PDF bulletins");
  const initialized = await getState(env, "spk_baseline_initialized");
  if (!initialized) {
    const latest = bulletins.at(-1)!;
    await env.DB.prepare("INSERT OR IGNORE INTO spk_bulletins(bulletin_number, bulletin_date, pdf_url, telegram_status) VALUES (?, ?, ?, 'baseline')").bind(latest.number, latest.date, latest.pdfUrl).run();
    await insertFeed(env, { type: "spk", source: "SPK", source_ref: `spk:${latest.number}`, title: `SPK Bülteni: ${latest.number}`, body: latest.date ? `Tarih: ${latest.date}` : null, url: latest.pdfUrl, tickers_json: "[]", published_at: latest.date });
    await setState(env, "spk_baseline_initialized", "1");
    console.info("SPK baseline initialized", { bulletin: latest.number });
    return;
  }
  for (const bulletin of bulletins) {
    const known = await env.DB.prepare("SELECT bulletin_number FROM spk_bulletins WHERE bulletin_number = ?").bind(bulletin.number).first();
    if (known) continue;
    await env.DB.prepare("INSERT INTO spk_bulletins(bulletin_number, bulletin_date, pdf_url, telegram_status) VALUES (?, ?, ?, 'pending')").bind(bulletin.number, bulletin.date, bulletin.pdfUrl).run();
    await insertFeed(env, { type: "spk", source: "SPK", source_ref: `spk:${bulletin.number}`, title: `SPK Bülteni: ${bulletin.number}`, body: bulletin.date ? `Tarih: ${bulletin.date}` : null, url: bulletin.pdfUrl, tickers_json: "[]", published_at: bulletin.date });
    try {
      await sendMessage(env, `📄 <b>Yeni SPK Bülteni yayımlandı</b>\n\nSPK Bülteni: <b>${escapeTelegramHtml(bulletin.number)}</b>${bulletin.date ? `\nTarih: ${escapeTelegramHtml(bulletin.date)}` : ""}`);
      await sendDocument(env, bulletin.pdfUrl, `SPK-Bulteni-${bulletin.number.replace("/", "-")}.pdf`);
      await env.DB.prepare("UPDATE spk_bulletins SET telegram_status = 'sent', telegram_sent_at = CURRENT_TIMESTAMP WHERE bulletin_number = ?").bind(bulletin.number).run();
    } catch (error) {
      console.warn("SPK telegram delivery failed", { bulletin: bulletin.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

