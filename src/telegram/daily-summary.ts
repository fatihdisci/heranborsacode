import type { Env } from '../types';
import { getIndices, type IndexMembership } from '../notifications/indices';
import { parsePublicKapPage } from '../kap/public';
import { shareActivity, type BuybackEvidence } from '../kap/share-activity';
import { fetchWithTimeout } from '../utils/http';
import { enqueueStatement } from './outbox';
import { splitText } from './actions';

export interface DailyDisclosure {
  disclosure_id: string; title: string; company: string | null; ticker: string | null;
  published_at: string; url: string; metadata_json: string | null;
}
export type SummaryKind = 'dkb' | 'pay';
export function istanbulDay(now = Date.now()): { day: string; start: string; end: string } {
  const day = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+03:00`);
  return { day, start: start.toISOString(), end: new Date(start.getTime() + 86400_000).toISOString() };
}
function metadata(row: DailyDisclosure): { codes?: string[]; subjectCodes?: string[]; buybackEvidence?: BuybackEvidence | null } {
  try { return JSON.parse(row.metadata_json ?? '{}') ?? {}; } catch { return {}; }
}
function codes(row: DailyDisclosure): string[] {
  const data = metadata(row);
  const values = data.subjectCodes ?? data.codes ?? (row.ticker ? [row.ticker] : []);
  return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && /^[A-Z][A-Z0-9]{3,4}$/.test(value)))] : [];
}

export function dailySummaryText(rows: DailyDisclosure[], indices: IndexMembership, day: string, now = Date.now(), kind: SummaryKind = 'dkb'): string {
  // A grouped Telegram message is never an event. KAP IDs deduplicate sources;
  // a repeated event for the same share still increments that share's count.
  rows = [...new Map(rows.map(row => [row.disclosure_id, row])).values()];
  const counts = new Map<string, number>();
  const breakers = rows.filter(row => /pay bazında devre kesici/i.test(row.title));
  let unknown = 0;
  for (const row of breakers) {
    const shares = codes(row);
    if (!shares.length) unknown++;
    for (const code of shares) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const entries = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const stats = (members: string[]) => {
    const selected = entries.filter(([code]) => members.includes(code));
    return `${selected.reduce((sum, [, count]) => sum + count, 0)} tetiklenme · ${selected.length} farklı hisse`;
  };
  const sections = [
    `📊 ${kind === 'dkb' ? 'Devre kesici özeti' : 'Pay işlemleri özeti'} · ${day}\nİstanbul saati ${new Date(now + 3 * 3600_000).toISOString().slice(11, 16)} itibarıyla kayıtlı KAP bildirimleri`,
    `DEVRE KESİCİ\n${breakers.length} KAP bildirimi · ${total} hisse bazında tetiklenme · ${counts.size} farklı hisse\nBIST 30: ${stats(indices.bist30)}\nBIST 100 (BIST 30 dahil): ${stats(indices.bist100)}\nBIST 100 içinde, BIST 30 dışında: ${stats(indices.bist100.filter(code => !indices.bist30.includes(code)))}\nBIST 100 dışında: ${stats(entries.map(([code]) => code).filter(code => !indices.bist100.includes(code)))}`,
    ...(unknown ? [`${unknown} devre kesici bildiriminin hisse kodu belirlenemedi; tetiklenme ve endeks sayımlarına eklenmedi.`] : []),
    ...(entries.length ? ['Hisse başına devre kesici sayısı:\n' + entries.map(([code, count]) => `#${code}: ${count}`).join(' · ')] : []),
  ];
  const coverage = 'Kayıtlarda bulunmayan veya henüz taranmayan bildirimler bu özete dahil değildir.';
  if (kind === 'dkb') return [...sections, `Sayım bildirimlerin yayın tarihine göre yapılır. ${coverage}`].join('\n\n');
  sections.splice(1);
  const buybacks = rows.filter(row => shareActivity(row.title) === 'buyback');
  const transactions: DailyDisclosure[] = [], decisions: DailyDisclosure[] = [], other: DailyDisclosure[] = [];
  for (const row of buybacks) {
    const evidence = metadata(row).buybackEvidence;
    const transaction = Array.isArray(evidence?.transactionDates) && evidence.transactionDates.includes(day);
    const decision = evidence?.decisionAnnounced && evidence.decisionDate === day;
    if (transaction) transactions.push(row);
    if (decision) decisions.push(row);
    if (!transaction && !decision) other.push(row);
  }
  const identity = (row: DailyDisclosure) => codes(row).join(',') || row.company || `KAP ${row.disclosure_id}`;
  const describe = (items: DailyDisclosure[]) => `${items.length} bildirim · ${new Set(items.map(identity)).size} şirket/bildiren taraf`;
  const lines = (items: DailyDisclosure[]) => items.length ? items.map(row => {
    const evidence = metadata(row).buybackEvidence;
    return `• ${codes(row).map(code => `#${code}`).join(' ') || row.company || 'Şirket kodu belirlenemedi'}${evidence?.correction ? ' (düzeltme bildirimi)' : ''}${evidence?.summary ? `\n${evidence.summary}` : ''}\n${row.url}`;
  }).join('\n') : 'Kayıtlı bildirim yok.';
  sections.push(`GERİ ALIM\nBugün yayımlanan toplam: ${describe(buybacks)}\n\nİşlem tarihi bugün olan geri alımları bildirenler: ${describe(transactions)}\n${lines(transactions)}\n\nBugün tarihli yeni geri alım kararı/programı bildirenler: ${describe(decisions)}\n${lines(decisions)}`);
  if (other.length) sections.push(`Diğer geri alım bildirimleri: ${other.length}\nÖnceki tarihli işlemler, program değişiklikleri veya işlem/karar tarihi doğrulanamayan kayıtlar; bugünkü alım/karar sayılarına dahil edilmedi.\n${lines(other)}`);
  const ownership = rows.filter(row => shareActivity(row.title) === 'ownership');
  sections.push(`PAY ALIM / SATIM\n${describe(ownership)}\n${lines(ownership)}\nBu bildirimler şirketin kendi payını geri almasıyla aynı işlem olarak sayılmaz.`);
  sections.push(`Sayım bildirimlerin yayın tarihine göre yapılır. Geri alımlarda işlem ve karar tarihi ayrıca doğrulanır; aynı şirketin birden fazla bildirimi tek şirket sayılır. ${coverage}`);
  return sections.join('\n\n');
}

export async function queueDailySummary(env: Env, messageId: number, now = Date.now(), kind: SummaryKind = 'dkb'): Promise<void> {
  const requestId = `day-summary:${kind}:${env.TELEGRAM_CHAT_ID}:${messageId}`;
  if (await env.DB.prepare('SELECT id FROM telegram_outbox WHERE id=?').bind(`${requestId}:0000`).first()) return;
  const { day, start, end } = istanbulDay(now);
  const result = await env.DB.prepare(`SELECT disclosure_id,title,company,ticker,published_at,url,metadata_json
    FROM kap_disclosures WHERE julianday(published_at)>=julianday(?) AND julianday(published_at)<julianday(?)
      AND julianday(published_at)<=julianday(?)
    ORDER BY published_at,disclosure_id`).bind(start, end, new Date(now).toISOString()).all<DailyDisclosure>();
  const rows = result.results ?? [];
  // Older records lack the labelled transaction evidence. Bound work so a
  // webhook remains within its lifetime; unread sources stay explicitly unknown.
  const missing = kind === 'pay' ? rows.filter(row => shareActivity(row.title) === 'buyback' && !metadata(row).buybackEvidence) : [];
  const deadline = Date.now() + 18_000;
  for (let offset = 0; offset < missing.length && Date.now() < deadline; offset += 4) {
    await Promise.all(missing.slice(offset, offset + 4).map(async row => {
      try {
        const url = `https://www.kap.org.tr/tr/Bildirim/${encodeURIComponent(row.disclosure_id)}`;
        const response = await fetchWithTimeout(url, { headers: { accept: 'text/html' } }, Math.max(1000, deadline - Date.now()));
        if (!response.ok) return;
        const html = await response.text();
        if (html.length > 3_000_000) return;
        const item = parsePublicKapPage(html, Number(row.disclosure_id));
        if (!item?.buybackEvidence) return;
        const updated = JSON.stringify({ ...metadata(row), buybackEvidence: item.buybackEvidence });
        await env.DB.prepare('UPDATE kap_disclosures SET metadata_json=? WHERE disclosure_id=?').bind(updated, row.disclosure_id).run();
        row.metadata_json = updated;
      } catch { /* Missing or ambiguous source remains in the unverified section. */ }
    }));
  }
  const indices = kind === 'dkb' ? await getIndices(env, now) : { bist30: [], bist100: [], source: '', checkedAt: '' };
  const pages = splitText(dailySummaryText(rows, indices, day, now, kind), 3000);
  await env.DB.batch(pages.map((text, index) => enqueueStatement(env, `${requestId}:${String(index).padStart(4, '0')}`, 'action_reply',
    { text: pages.length > 1 ? `${text}\n\nBölüm ${index + 1}/${pages.length}` : text, plain: true, replyTo: messageId }, null, new Date(now).toISOString(), null)));
}
