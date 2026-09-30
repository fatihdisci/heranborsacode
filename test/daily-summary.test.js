import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database } from './db-harness';
import { dailySummaryText, istanbulDay, queueDailySummary } from '../src/telegram/daily-summary';
import { parseBuybackEvidence, shareActivity } from '../src/kap/share-activity';
import { decide, DEFAULTS } from '../src/notifications/rules';
import { isImportantPublicDisclosure } from '../src/kap/importance';
import { deliverOne } from '../src/telegram/outbox';
import { telegramRoutes } from '../src/telegram/webhook';

let sql, env;
const indices = { bist30: ['THYAO'], bist100: ['THYAO', 'ARSAN'], source: 'test', checkedAt: '2026-09-30' };
const day = '2026-09-30';
const now = Date.parse('2026-09-30T16:00:00Z');
const row = (id, title, codes, evidence) => ({ disclosure_id: String(id), title, ticker: codes[0], company: 'Şirket', published_at: '2026-09-30T10:00:00Z', url: `https://www.kap.org.tr/tr/Bildirim/${id}`, metadata_json: JSON.stringify({ subjectCodes: codes, buybackEvidence: evidence }) });
const breaker = (id, codes) => row(id, 'Pay Bazında Devre Kesici Bildirimi', codes);
beforeEach(() => { ({ sql, env } = database()); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { sql.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('uses Istanbul calendar midnight rather than UTC midnight', () => {
  expect(istanbulDay(Date.parse('2026-09-30T21:01:00Z'))).toEqual({ day: '2026-10-01', start: '2026-09-30T21:00:00.000Z', end: '2026-10-01T21:00:00.000Z' });
});
it('deduplicates KAP IDs but counts repeated breakers for one share and nested index membership', () => {
  const text = dailySummaryText([breaker(1, ['THYAO']), breaker(1, ['THYAO']), breaker(2, ['THYAO']), breaker(3, ['ARSAN']), breaker(4, ['ZZZZ'])], indices, day, now);
  expect(text).toContain('4 KAP bildirimi · 4 hisse bazında tetiklenme · 3 farklı hisse');
  expect(text).toContain('BIST 30: 2 tetiklenme · 1 farklı hisse');
  expect(text).toContain('BIST 100 (BIST 30 dahil): 3 tetiklenme · 2 farklı hisse');
  expect(text).toContain('BIST 100 içinde, BIST 30 dışında: 1 tetiklenme · 1 farklı hisse');
  expect(text).toContain('#THYAO: 2');
});
it('does not assign unknown breaker tickers to an index or count index-wide notices as share triggers', () => {
  const text = dailySummaryText([breaker(1, []), row(2, 'Endeks Bazında Devre Kesici Bildirimi', ['THYAO'])], indices, day, now);
  expect(text).toContain('1 KAP bildirimi · 0 hisse bazında tetiklenme');
  expect(text).toContain('hisse kodu belirlenemedi');
});
it('reads labelled transaction dates, ignores hidden duplicates and does not treat an old board date as a new decision', () => {
  const html = `<div class="disclosureScrollableArea"><table>
    <tr><td>Özet Bilgi</td><td>30 Eylül 2026 tarihli pay geri alım işlemleri</td></tr>
    <tr><td>Yönetim Kurulu Karar Tarihi</td><td>29.06.2026</td></tr>
    </table><h3>Geri Alım İşlemlerinin Detayları</h3><table>
    <tr><td>İşleme Konu Pay</td><td>İşlem Tarihi</td><td>İşleme Konu Payların Nominal Tutarı (TL)</td></tr>
    <tr><td>ARSAN</td><td>29.09.2026</td><td>100</td></tr>
    <tr><td>ARSAN</td><td>30.09.2026</td><td>200</td></tr>
    <tr style="display:none"><td>ARSAN</td><td>01.10.2026</td><td>200</td></tr></table></div>`;
  expect(parseBuybackEvidence(html)).toMatchObject({ transactionDates: ['2026-09-29', '2026-09-30'], decisionDate: '2026-06-29', decisionAnnounced: false });
  expect(parseBuybackEvidence('<nav>Geri alım yapılacak</nav>')).toBeNull();
});
it('separates actual transaction dates, decision dates, unverified sources and ownership filings', () => {
  const evidence = { transactionDates: [day], decisionDate: '2026-06-29', decisionAnnounced: false, summary: 'Geri alım işlemleri', correction: false };
  const text = dailySummaryText([
    row(1, 'Payların Geri Alınmasına İlişkin Bildirim', ['ARSAN'], evidence),
    row(2, 'Payların Geri Alınmasına İlişkin Bildirim', ['ARSAN'], evidence),
    row(3, 'Payların Geri Alınmasına İlişkin Bildirim', ['THYAO'], { ...evidence, transactionDates: [], decisionDate: day, decisionAnnounced: true }),
    row(4, 'Payların Geri Alınmasına İlişkin Bildirim', ['ZZZZ'], { ...evidence, transactionDates: ['2026-09-29'] }),
    row(5, 'Pay Alım Satım Bildirimi', ['THYAO']),
  ], indices, day, now);
  expect(text).toContain('İşlem tarihi bugün olan geri alımları bildirenler: 2 bildirim · 1 şirket');
  expect(text).toContain('Bugün tarihli yeni geri alım kararı/programı bildirenler: 1 bildirim · 1 şirket');
  expect(text).toContain('Diğer geri alım bildirimleri: 1');
  expect(text).toContain('PAY ALIM / SATIM\n1 bildirim');
});
it('recognizes program starts but not program termination as a new buyback decision', () => {
  const html = summary => `<div class="disclosureScrollableArea"><table><tr><td>Özet Bilgi</td><td>${summary}</td></tr><tr><td>Yönetim Kurulu Karar Tarihi</td><td>30.09.2026</td></tr></table></div>`;
  expect(parseBuybackEvidence(html('Pay geri alım programı başlatılması kararı')).decisionAnnounced).toBe(true);
  expect(parseBuybackEvidence(html('Pay geri alım programının sonlandırılması kararı')).decisionAnnounced).toBe(false);
});
it('preserves share activity notifications despite old endeks, watch and exclusion filters', () => {
  for (const title of ['Pay Alım Bildirimi', 'Pay Satım Bildirimi', 'Pay Alım Satım Bildirimi', 'Payların Geri Alınmasına İlişkin Bildirim']) {
    expect(shareActivity(title)).not.toBeNull();
    expect(isImportantPublicDisclosure({ title, company: 'Şirket', codes: ['ZZZZ'] })).toBe(true);
    const prefs = { ...DEFAULTS, otherCompanies: 'off', excludedTitles: ['Pay'], priorityIndices: false };
    expect(decide({ type: 'kap', title, body: 'Şirket', tickers_json: '["ZZZZ"]' }, prefs, indices).action).toBe('instant');
  }
});
it('counts filtered source records, excludes adjacent Istanbul days, queues idempotently and delivers through outbox', async () => {
  for (const [id, date] of [[1, '2026-09-29T20:59:59Z'], [2, '2026-09-29T21:00:00Z'], [3, '2026-09-30T20:59:59Z'], [4, '2026-09-30T21:00:00Z']]) {
    sql.prepare('INSERT INTO kap_disclosures(disclosure_id,title,ticker,published_at,url,content_hash,telegram_status) VALUES (?,?,?,?,?,?,?)').run(String(id), 'Pay Bazında Devre Kesici Bildirimi', 'THYAO', date, 'https://www.kap.org.tr/tr/Bildirim/' + id, 'test' + id, 'filtered');
  }
  const endOfDay = Date.parse('2026-09-30T20:59:59.999Z');
  await queueDailySummary(env, 55, endOfDay); await queueDailySummary(env, 55, endOfDay);
  expect(sql.prepare('SELECT COUNT(*) n FROM telegram_outbox').get().n).toBe(1);
  const payload = JSON.parse(sql.prepare('SELECT payload FROM telegram_outbox').get().payload);
  expect(payload.text).toContain('2 KAP bildirimi · 2 hisse bazında tetiklenme · 1 farklı hisse');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }))));
  await deliverOne(env);
  expect(sql.prepare('SELECT status FROM telegram_outbox').get().status).toBe('sent');
});
it('accepts plain Turkish requests and slash commands only in the authorized private chat', async () => {
  env.TELEGRAM_WEBHOOK_SECRET = 'test'; const pending = [];
  for (const [id, text, from] of [[1, 'günü özetle', 123], [2, '/gunuozetle', 123], [3, 'günü özetle', 456]]) {
    await telegramRoutes(new Request('https://worker/api/telegram/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test' }, body: JSON.stringify({ message: { message_id: id, text, from: { id: from }, chat: { id: 123, type: 'private' } } }) }), env, { waitUntil: promise => pending.push(promise) });
  }
  await Promise.all(pending);
  expect(sql.prepare('SELECT COUNT(*) n FROM telegram_outbox').get().n).toBe(2);
});
