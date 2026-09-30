import { parseHTML } from 'linkedom';

const normalize = (value: string) => value.toLocaleUpperCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'I').replace(/\s+/g, ' ').trim();
export function shareActivity(title: string): 'buyback' | 'ownership' | null {
  const text = normalize(title);
  if (/GERI AL|GERI SAT|GERI ALINAN PAY/.test(text)) return 'buyback';
  if (/PAY ALIM|PAY SATIM/.test(text)) return 'ownership';
  return null;
}

export interface BuybackEvidence {
  transactionDates: string[];
  decisionDate: string | null;
  decisionAnnounced: boolean;
  correction: boolean;
  summary: string;
}
function date(value: string): string | null {
  const match = value.trim().match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  if (!match) return null;
  const result = `${match[3]}-${match[2]}-${match[1]}`;
  const timestamp = Date.parse(`${result}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === result ? result : null;
}

// Read only the disclosure body and explicitly labelled fields. A program's
// original board date is not evidence that a new decision was announced today.
export function parseBuybackEvidence(html: string): BuybackEvidence | null {
  // Avoid parsing navigation and the large duplicated React payload on each
  // live scan. Match the rendered body and balance its nested div elements.
  const opening = /<div\b[^>]*class=["'][^"']*\bdisclosureScrollableArea\b[^"']*["'][^>]*>/g.exec(html);
  if (!opening) return null;
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = opening.index + opening[0].length;
  let depth = 1, end = 0;
  for (let match; (match = tags.exec(html));) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (!depth) { end = tags.lastIndex; break; }
  }
  if (!end) return null;
  const { document } = parseHTML(html.slice(opening.index, end));
  const roots = document.querySelectorAll('.disclosureScrollableArea');
  if (roots.length !== 1) return null;
  const root = roots[0].cloneNode(true) as Element;
  root.querySelectorAll('script,style,[hidden],[aria-hidden="true"]').forEach(el => el.remove());
  root.querySelectorAll('[style]').forEach(el => {
    if (/(?:^|;)\s*display\s*:\s*none\s*(?:!important)?\s*(?:;|$)/i.test(el.getAttribute('style') ?? '')) el.remove();
  });
  const result: BuybackEvidence = { transactionDates: [], decisionDate: null, decisionAnnounced: false, correction: false, summary: '' };
  const fields = new Map<string, string>();
  for (const row of root.querySelectorAll('tr')) {
    const cells = [...row.children].filter(el => /^(TD|TH)$/.test(el.tagName));
    if (cells.length === 2 && !cells.some(cell => cell.querySelector('table'))) fields.set(normalize(cells[0].textContent ?? ''), (cells[1].textContent ?? '').trim());
  }
  result.summary = fields.get('OZET BILGI') ?? '';
  result.decisionDate = date(fields.get('YONETIM KURULU KARAR TARIHI') ?? '');
  result.correction = normalize(fields.get('YAPILAN ACIKLAMA DUZELTME MI ?') ?? '').startsWith('EVET');
  const summary = normalize(result.summary);
  result.decisionAnnounced = /GERI AL/.test(summary) && /BASLAT|KARAR|PROGRAM.{0,60}ONAY|ONAY.{0,60}PROGRAM/.test(summary) && !/SONLANDIR|SONA ER|IPTAL/.test(summary);
  for (const table of root.querySelectorAll('table')) {
    if (table.querySelector('table')) continue;
    const rows = [...table.querySelectorAll('tr')].map(row => [...row.children].filter(el => /^(TD|TH)$/.test(el.tagName)).map(cell => (cell.textContent ?? '').trim()));
    const header = rows.findIndex(row => row.some(cell => normalize(cell) === 'ISLEM TARIHI'));
    if (header < 0 || !rows[header].some(cell => /ISLEME KONU PAYLARIN NOMINAL TUTARI/.test(normalize(cell)))) continue;
    const column = rows[header].findIndex(cell => normalize(cell) === 'ISLEM TARIHI');
    for (const row of rows.slice(header + 1)) {
      const transactionDate = date(row[column] ?? '');
      if (transactionDate) result.transactionDates.push(transactionDate);
    }
  }
  result.transactionDates = [...new Set(result.transactionDates)].sort();
  return result.summary || result.transactionDates.length || result.decisionDate ? result : null;
}
