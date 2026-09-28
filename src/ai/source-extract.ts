import { parseHTML } from 'linkedom';
import type { FeedItem } from '../types';
import { decodeEntities, normalizeUrl } from '../utils/text';

type Target = Pick<FeedItem, 'type' | 'url' | 'title'>;
export interface ArticleSource { text: string; html: string; }
const clean = (value: string) => value.replace(/\s+/g,' ').trim();
const normalized = (value: string) => clean(value).toLocaleLowerCase('tr-TR');
const NOISE = 'script,style,noscript,svg,nav,aside,footer,form,button,iframe,[hidden],[aria-hidden="true"],.related-news,.related-articles,.recommended,.recommendations,.advertisement,.ad-container,.social-share,.cookie-banner';

function articleRecords(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) { value.forEach(v => articleRecords(v,output)); return; }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string,unknown>;
  const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
  if (types.some(type => typeof type === 'string' && /(?:NewsArticle|Article|Report|BlogPosting)$/.test(type)) && typeof record.articleBody === 'string') output.push(record);
  // Related stories in itemListElement, mentions, etc. are not this article.
  if (record['@graph']) articleRecords(record['@graph'],output);
  if (record.mainEntity && typeof record.mainEntity === 'object') articleRecords(record.mainEntity,output);
}

function matchesTarget(record: Record<string,unknown>, target: Target): boolean {
  const entity = record.mainEntityOfPage;
  const url = record.url ?? (typeof entity === 'string' ? entity : entity && typeof entity === 'object' ? (entity as Record<string,unknown>)['@id'] : undefined);
  if (typeof url === 'string') {
    try { return normalizeUrl(new URL(url,target.url).href) === normalizeUrl(target.url); } catch { return false; }
  }
  return typeof record.headline === 'string' && normalized(record.headline) === normalized(target.title);
}

// Preserve rows, units and merged-cell information. Flattening all table cells
// into one sentence can associate a value with the wrong period or shareholder.
function readable(root: Element): string {
  const parts: string[] = [];
  let pending = '';
  const flush = () => { const text = clean(pending); pending=''; if (text) parts.push(text); };
  function walk(node: Node): void {
    if (node.nodeType === 3) { pending += node.textContent ?? ''; return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'table' && !el.querySelector('table')) {
      flush();
      const span = (cell: Element, name: string) => Math.max(1,Math.min(1000,Number.parseInt(cell.getAttribute(name) ?? '1',10)||1));
      const rows = [...el.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => ({
        text:clean(cell.textContent ?? ''), header:cell.tagName.toLowerCase()==='th', rowSpan:span(cell,'rowspan'), colSpan:span(cell,'colspan'),
      })));
      if (rows.length) parts.push(`TABLO (satır sırası ve hücre birleşimleri korunmuştur):\n${JSON.stringify(rows)}`);
      return;
    }
    const boundary = /^(p|div|section|br|li|h[1-6]|tr|td|th)$/.test(tag);
    if (boundary) flush();
    for (const child of el.childNodes) walk(child);
    if (boundary) flush();
  }
  walk(root);flush();
  const text = parts.join('\n\n');
  if (text.length > 100_000) throw new Error('Kaynak güvenli içerik boyutunu aşıyor; sessizce kesilmedi');
  return text;
}

export function extractArticleSource(html: string, target?: Target): ArticleSource {
  const {document} = parseHTML(html);
  const records: Record<string,unknown>[]=[];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw=script.textContent ?? '';
    try { articleRecords(JSON.parse(raw),records); }
    catch { try { articleRecords(JSON.parse(decodeEntities(raw)),records); } catch { /* invalid structured data */ } }
  }
  document.querySelectorAll(NOISE).forEach(el=>el.remove());
  const selectors = target?.type === 'kap' ? ['.disclosureScrollableArea'] : [
    '[itemprop="articleBody"], .article-body, .cms-container, .news-detail-content, .news-content, [data-test="article-body"]', 'article',
  ];
  for (const selector of selectors) {
    const all=[...document.querySelectorAll(selector)];
    const roots=all.filter(el=>!all.some(other=>other!==el && other.contains(el)));
    const matching = target ? roots.filter(el => {
      const heading=el.querySelector('h1,h2');return heading && normalized(heading.textContent ?? '')===normalized(target.title);
    }) : [];
    const root = matching.length===1 ? matching[0] : roots.length===1 ? roots[0] : null;
    if (!root) continue;
    const text=readable(root);
    if (text.length >= 20) return {text,html:root.outerHTML};
  }
  if (target?.type !== 'kap') {
    const matched=target ? records.filter(record=>matchesTarget(record,target)) : records;
    const unique=[...new Map(matched.map(record=>[String(record.articleBody),record])).values()];
    if (unique.length===1) {
      const record=unique[0];
      const {document:fragment}=parseHTML(`<article>${String(record.articleBody)}</article>`);
      fragment.querySelectorAll(NOISE).forEach(el=>el.remove());
      const text=readable(fragment.firstElementChild!);
      if (text.length>=20) return {text,html:fragment.firstElementChild!.outerHTML};
    }
  }
  throw new Error('Kaynağın ana metni güvenle ayrıştırılamadı; yalnız başlıktan taslak üretilmedi');
}
