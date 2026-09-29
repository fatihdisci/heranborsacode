import { getIndices } from "../notifications/indices";
import type { Env } from "../types";
import { feedStatement } from "../db/feed";
import { enqueueStatement } from "../telegram/outbox";
import { fetchWithTimeout } from "../utils/http";
import { escapeTelegramHtml, sha256 } from "../utils/text";
import { isImportantPublicDisclosure } from "./importance";
export { isImportantPublicDisclosure } from "./importance";
import { getPreferences, classify, isMutedKapTitle } from "../notifications/rules";
import { financeNotificationCutoff, publishedSince } from '../db/state';

const PUBLIC_KAP_URL = "https://www.kap.org.tr/tr/Bildirim";
const LIVE_CURSOR_KEY = "public_kap_cursor";
const BACKFILL_CURSOR_KEY = "public_kap_backfill_cursor";
const LATEST_KNOWN_ID = 1665624;
// The verified public cursor was 1665624. Starting shortly before it brings
// the last-24-hour Mini App history in through a silent low-CPU shard.
const BACKFILL_START_ID = 1665600;
// Keep each alarm comfortably below the free-plan CPU ceiling. The live alarm
// runs every 30 seconds, so this still drains up to six disclosures per minute.
const LIVE_BATCH_SIZE = 3;
const BACKFILL_BATCH_SIZE = 3;

export interface PublicKapScanResult {
  scanned: number;
  reachedEdge: boolean;
}

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
  issuerCode?: string | null;
  disclosureClass: string;
  disclosureType: string;
  summary: string | null;
  resumeAt: string | null;
  publishedAt: string | null;
  url: string;
}

export function disclosureSubjectCodes(item: PublicDisclosure): string[] {
  if (isCircuitBreaker(item)) return item.codes;
  if (item.issuerCode && /^[A-Z][A-Z0-9]{3,4}$/.test(item.issuerCode)) return [item.issuerCode];
  // KAP's relatedStocks can list an entire index. With no listed issuer, a
  // single related share is unambiguous; a longer list is not.
  return item.codes.length === 1 ? item.codes : [];
}

function parseDate(value: string | undefined): string | null {
  const match = value?.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  // KAP timestamps are Europe/Istanbul (+03:00), not browser-local time.
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 3, Number(minute), Number(second))).toISOString();
}

function codes(value: unknown, stockCode: string | null | undefined, companyTitle: string | undefined): string[] {
  const listed = typeof value === "string" ? value.split(/[,;\s]+/) : Array.isArray(value) ? value.flatMap(item => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string") return [(item as { code: string }).code];
    return [];
  }) : [];
  // KAP also exposes short institution/fund codes in stockCode (for example
  // SKP for a portfolio manager). They are not BIST equity tickers and must
  // not be rendered as hashtags. relatedStocks remains authoritative.
  if (stockCode && !/PORTFÖY YÖNETİMİ|EMEKLİLİK VE HAYAT/i.test(companyTitle ?? "")) listed.push(stockCode);
  return [...new Set(listed.map(code => code.trim().toUpperCase()).filter(code => /^[A-Z][A-Z0-9]{3,4}$/.test(code)))];
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
    codes: codes(basic.relatedStocks, basic.stockCode, basic.companyTitle),
    issuerCode: codes(null, basic.stockCode, basic.companyTitle)[0] ?? null,
    disclosureClass: basic.disclosureClass ?? "",
    disclosureType: basic.disclosureType ?? "",
    summary: basic.summary ?? null,
    resumeAt: html.match(/işlemlere\s+(\d{2}:\d{2}:\d{2})\s+itibarıyla devam edilecektir/i)?.[1] ?? null,
    publishedAt: parseDate(basic.publishDate),
    url: `${PUBLIC_KAP_URL}/${requestedId}`,
  };
}

function isCircuitBreaker(item: PublicDisclosure): boolean {
  return /DEVRE KESİCİ/.test(`${item.title} ${item.summary ?? ""}`.toLocaleUpperCase("tr-TR"));
}

export function circuitBreakerBody(item: PublicDisclosure): string | null {
  if (!isCircuitBreaker(item)) return null;
  return "Devre kesici uygulandı. Sürekli işleme ara verildi.";
}

export function circuitBreakerMessage(items: PublicDisclosure[]): string | null {
  const codes = [...new Set(items.filter(isCircuitBreaker).flatMap(item => item.codes))];
  if (!codes.length) return null;
  return `${codes.map(code => `#${code}`).join(" ")}\n\nDevre kesici uygulandı. Sürekli işleme ara verildi.`;
}

export function suppressPublicKapNotification(title: string): boolean {
  const normalized = title.toLocaleUpperCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return isMutedKapTitle(title) || /IHRAC BELGESI|FON IHRAC SOZLESMESI|KREDI KULLANIMI/.test(normalized);
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
  const preferences=await getPreferences(env);
  const subjectCodes=disclosureSubjectCodes(item);
  const topics=classify({title:item.title,body:item.company,tickers_json:JSON.stringify(subjectCodes)}).topics;
  const explicitlyTracked=preferences.watchlist.some(w=>subjectCodes.includes(w.ticker)&&(w.mode==='all'||w.mode==='topics'&&w.topics.some(t=>topics.includes(t))));
  const priorityCodes=[...preferences.watchlist.map(w=>w.ticker),...(preferences.priorityIndices?(await getIndices(env)).bist100:[])];
  const explicitlySelectedTopic=preferences.otherCompanies==='topics'&&preferences.otherTopics.some(topic=>topics.includes(topic));
  // Keep broad market announcements in the main KAP flow, without pretending
  // that every related share is the issuer or qualifies for an index alert.
  const marketwide=subjectCodes.length===0&&item.codes.length>0&&!/PAY ALIM BİLDİRİMİ|PAY SATIM BİLDİRİMİ/i.test(item.title);
  const important=isImportantPublicDisclosure({...item,codes:subjectCodes},priorityCodes)||
    marketwide&&isImportantPublicDisclosure(item,[]);
  if (!important && !explicitlyTracked && !explicitlySelectedTopic) return;
  const known = await env.DB.prepare("SELECT disclosure_id FROM kap_disclosures WHERE disclosure_id=?").bind(String(item.id)).first();
  if (known) return;
  const breakerBody = circuitBreakerBody(item);
  const firstSeen = new Date().toISOString();
  const ref = `kap:${item.id}`;
  const heading = subjectCodes[0] ? `#${escapeTelegramHtml(subjectCodes[0])}` : marketwide ? "🏦 <b>KAP</b>" : "🏦 <b>KAP · Fon/Portföy</b>";
  const message = `${heading}\nKAP bildirimi\n\n${escapeTelegramHtml(item.title)}${item.company ? `\n${escapeTelegramHtml(item.company)}` : ""}`;
  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO kap_disclosures(disclosure_id,company,ticker,title,disclosure_type,published_at,url,metadata_json,content_hash,telegram_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(String(item.id), item.company, subjectCodes[0] ?? null, item.title, item.disclosureType || item.disclosureClass, item.publishedAt, item.url, JSON.stringify({...item,subjectCodes}), await sha256(ref), silent ? "baseline" : "pending", firstSeen),
    feedStatement(env, { type: "kap", source: "KAP", source_ref: ref, title: item.title, body: breakerBody ?? item.company, url: item.url, tickers_json: JSON.stringify(item.codes), published_at: item.publishedAt }),
  ];
  if (!silent) statements.push(enqueueStatement(env, ref, breakerBody && item.codes.length ? 'dkb' : 'message',
    breakerBody && item.codes.length ? { codes: item.codes } : { text: message, button: { text: "🔗 KAP'ta Aç", url: item.url } }, item.publishedAt, firstSeen));
  // Atomically persist source, feed and delivery before advancing the cursor.
  await env.DB.batch(statements);
}

async function getState(env: Env, key: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM system_state WHERE key=?").bind(key).first<{ value: string }>();
  return row && /^\d+$/.test(row.value) ? Number(row.value) : null;
}

async function setState(env: Env, key: string, value: number): Promise<void> {
  // A live alarm already in flight must not move a manually fast-forwarded
  // cursor backward after it finishes an older disclosure.
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=CASE WHEN CAST(excluded.value AS INTEGER)>CAST(system_state.value AS INTEGER) THEN excluded.value ELSE system_state.value END,updated_at=CURRENT_TIMESTAMP").bind(key, String(value)).run();
}

async function scan(env: Env, key: string, start: number, ceiling: number | null, silent: boolean, batchSize: number): Promise<PublicKapScanResult> {
  let cursor = (await getState(env, key)) ?? start;
  const cutoff = silent ? null : await financeNotificationCutoff(env);
  let scanned = 0;
  for (let step = 0; step < batchSize; step++) {
    const id = cursor + 1;
    if (ceiling !== null && id > ceiling) return { scanned, reachedEdge: true };
    const item = await getDisclosure(id);
    if (!item) return { scanned, reachedEdge: true }; // Public KAP uses the first missing numeric ID as the live edge.
    if (!silent || within24Hours(item.publishedAt)) await store(env, item, silent || !publishedSince(item.publishedAt, cutoff));
    cursor = id;
    scanned++;
    await setState(env, key, cursor);
  }
  return { scanned, reachedEdge: false };
}

export async function pollPublicKAPLive(env: Env): Promise<PublicKapScanResult> {
  return scan(env, LIVE_CURSOR_KEY, LATEST_KNOWN_ID, null, false, LIVE_BATCH_SIZE);
}

export async function pollPublicKAPBackfill(env: Env): Promise<void> {
  await scan(env, BACKFILL_CURSOR_KEY, BACKFILL_START_ID, LATEST_KNOWN_ID, true, BACKFILL_BATCH_SIZE);
}

export async function pollPublicKAP(env: Env): Promise<void> {
  // Backfill is deliberately silent: it populates the Mini App, never replays
  // historical Telegram messages. The live cursor continues independently.
  await pollPublicKAPBackfill(env);
  await pollPublicKAPLive(env);
}
