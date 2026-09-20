import type { Env } from "../types";
import { insertFeed } from "../db/feed";
import { sendMessage } from "../telegram/client";
import { fetchWithTimeout } from "../utils/http";
import { escapeTelegramHtml, sha256 } from "../utils/text";
import { BIST50 } from "./bist50";

const PUBLIC_KAP_URL = "https://www.kap.org.tr/tr/Bildirim";
const LIVE_CURSOR_KEY = "public_kap_cursor";
const BACKFILL_CURSOR_KEY = "public_kap_backfill_cursor";
const LATEST_KNOWN_ID = 1665624;
// The verified public cursor was 1665624. Starting shortly before it brings
// the last-24-hour Mini App history in within two scheduled batches.
const BACKFILL_START_ID = 1665600;
const BATCH_SIZE = 20;

interface BasicDisclosure {
  title?: string;
  companyTitle?: string;
  stockCode?: string | null;
  relatedStocks?: unknown;
  disclosureClass?: string;
  disclosureType?: string;
  publishDate?: string;
  disclosureIndex?: number;
  summary?: string | null;
}

export interface PublicDisclosure {
  id: number;
  title: string;
  company: string | null;
  codes: string[];
  disclosureClass: string;
  disclosureType: string;
  publishedAt: string | null;
  url: string;
}

function parseDate(value: string | undefined): string | null {
  const match = value?.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  // KAP timestamps are Europe/Istanbul (+03:00), not browser-local time.
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 3, Number(minute), Number(second))).toISOString();
}

function codes(value: unknown, stockCode: string | null | undefined): string[] {
  const listed = Array.isArray(value) ? value.flatMap(item => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string") return [(item as { code: string }).code];
    return [];
  }) : [];
  if (stockCode) listed.push(stockCode);
  return [...new Set(listed.map(code => code.trim().toUpperCase()).filter(code => /^[A-Z][A-Z0-9]{1,5}$/.test(code)))];
}

export function parsePublicKapPage(html: string, requestedId: number): PublicDisclosure | null {
  // Next.js serializes page data inside a JSON string; unescape only its JSON
  // quotation marks before extracting the disclosureBasic object.
  const decoded = html.replace(/\\"/g, '"');
  const match = decoded.match(/"disclosureBasic":(\{.*?\}),"disclosureDetail"/s);
  if (!match) return null;
  let basic: BasicDisclosure;
  try { basic = JSON.parse(match[1]) as BasicDisclosure; } catch { return null; }
  if (basic.disclosureIndex !== requestedId || !basic.title) return null;
  return {
    id: requestedId,
    title: basic.title,
    company: basic.companyTitle ?? null,
    codes: codes(basic.relatedStocks, basic.stockCode),
    disclosureClass: basic.disclosureClass ?? "",
    disclosureType: basic.disclosureType ?? "",
    publishedAt: parseDate(basic.publishDate),
    url: `${PUBLIC_KAP_URL}/${requestedId}`,
  };
}

export function isImportantPublicDisclosure(item: PublicDisclosure): boolean {
  const title = `${item.title} ${item.company ?? ""}`.toLocaleUpperCase("tr-TR");
  if (!item.codes.length) return /FON|PORTFÖY|VARLIK YÖNETİM/.test(title);
  if (/ŞİRKET GENEL BİLGİ FORMU|HAK KULLANIM SÜREÇ DURUMU/.test(title)) return false;
  // The Mac mini flow applies the BIST 50 restriction to the specific pay
  // buy/sell notification class, not to normal share-repurchase disclosures.
  if (/PAY ALIM BİLDİRİMİ|PAY SATIM BİLDİRİMİ/.test(title)) return item.codes.some(code => BIST50.has(code));
  return true;
}

function within24Hours(value: string | null): boolean {
  return Boolean(value && Date.parse(value) >= Date.now() - 24 * 60 * 60 * 1000);
}

async function getDisclosure(id: number): Promise<PublicDisclosure | null> {
  const response = await fetchWithTimeout(`${PUBLIC_KAP_URL}/${id}`, {
    headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; HeranBorsa/1.0)" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Public KAP HTTP ${response.status}`);
  return parsePublicKapPage(await response.text(), id);
}

async function store(env: Env, item: PublicDisclosure, silent: boolean): Promise<void> {
  if (!isImportantPublicDisclosure(item)) return;
  const write = await env.DB.prepare("INSERT OR IGNORE INTO kap_disclosures(disclosure_id,company,ticker,title,disclosure_type,published_at,url,metadata_json,content_hash,telegram_status) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(String(item.id), item.company, item.codes[0] ?? null, item.title, item.disclosureType || item.disclosureClass, item.publishedAt, item.url, JSON.stringify(item), await sha256(`kap:${item.id}`), silent ? "baseline" : "pending").run();
  if (!write.meta.changes) return;
  await insertFeed(env, { type: "kap", source: "KAP", source_ref: `kap:${item.id}`, title: item.title, body: item.company, url: item.url, tickers_json: JSON.stringify(item.codes), published_at: item.publishedAt });
  if (silent) return;
  try {
    const heading = item.codes[0] ? `🏢 <b>#${escapeTelegramHtml(item.codes[0])}</b>` : "🏦 <b>KAP · Fon/Portföy</b>";
    await sendMessage(env, `${heading}\nKAP bildirimi\n\n${escapeTelegramHtml(item.title)}${item.company ? `\n${escapeTelegramHtml(item.company)}` : ""}`, { text: "🔗 KAP'ta Aç", url: item.url });
    await env.DB.prepare("UPDATE kap_disclosures SET telegram_status='sent',telegram_sent_at=CURRENT_TIMESTAMP WHERE disclosure_id=?").bind(String(item.id)).run();
  } catch (error) {
    console.warn("public KAP telegram delivery failed", { id: item.id, error: error instanceof Error ? error.message : String(error) });
  }
}

async function getState(env: Env, key: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM system_state WHERE key=?").bind(key).first<{ value: string }>();
  return row && /^\d+$/.test(row.value) ? Number(row.value) : null;
}

async function setState(env: Env, key: string, value: number): Promise<void> {
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(key, String(value)).run();
}

async function scan(env: Env, key: string, start: number, ceiling: number | null, silent: boolean): Promise<void> {
  let cursor = (await getState(env, key)) ?? start;
  for (let step = 0; step < BATCH_SIZE; step++) {
    const id = cursor + 1;
    if (ceiling !== null && id > ceiling) return;
    const item = await getDisclosure(id);
    if (!item) return; // Public KAP uses the first missing numeric ID as the live edge.
    if (!silent || within24Hours(item.publishedAt)) await store(env, item, silent);
    cursor = id;
    await setState(env, key, cursor);
  }
}

export async function pollPublicKAP(env: Env): Promise<void> {
  // Backfill is deliberately silent: it populates the Mini App, never replays
  // historical Telegram messages. The live cursor continues independently.
  await scan(env, BACKFILL_CURSOR_KEY, BACKFILL_START_ID, LATEST_KNOWN_ID, true);
  await scan(env, LIVE_CURSOR_KEY, LATEST_KNOWN_ID, null, false);
}
