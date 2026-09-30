import { parseHTML } from 'linkedom';
import type { FeedItem } from '../types';
import { decodeEntities, normalizeUrl } from '../utils/text';
import { sourceTable, type SourceDocument } from './source-document';

type Target = Pick<FeedItem, 'type' | 'url' | 'title'>;
export interface ArticleSource { text: string; html: string; document: SourceDocument; }
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
function readable(root: Element): {text:string; document:SourceDocument} {
  const parts: string[] = [];
  const document:SourceDocument={version:1,passages:[],tables:[]};
  let section='', previousText='';
  let pending = '';
  const flush = () => {
    const text = clean(pending); pending='';
    if(text) {parts.push(text);document.passages.push({id:`p${document.passages.length+1}`,text,section});previousText=text;}
  };
  function walk(node: Node): void {
    if (node.nodeType === 3) { pending += node.textContent ?? ''; return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if(/^h[1-6]$/.test(tag) || el.classList.contains('bgGreen')) {flush();section=clean(el.textContent??'');previousText='';}
    if (tag === 'table' && !el.querySelector('table')) {
      flush();
      const caption=clean(el.querySelector('caption')?.textContent??'');
      const context=[section,caption,previousText].filter(text=>text.length<240 && /(?:bin|milyon|milyar)\s*(?:TL|TRY|USD|EUR|Avro|Euro)\b|(?:tutarlar|rakamlar|birim)\s*[:(]/i.test(text)).join(' / ');
      const table=sourceTable(el,`t${document.tables.length+1}`,section,context);
      document.tables.push(table);
      if(table.rows.length)parts.push(`TABLO (satır sırası ve hücre birleşimleri korunmuştur):\n${JSON.stringify(table.rows)}`);
      previousText='';
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
  if(JSON.stringify(document).length>350_000)throw new Error('Kaynak tabloları güvenli içerik boyutunu aşıyor; sessizce kesilmedi');
  return {text,document};
}

export function extractArticleSource(html: string, target?: Target): ArticleSource {
  const {document} = parseHTML(html);
  const records: Record<string,unknown>[]=[];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw=script.textContent ?? '';
    try { articleRecords(JSON.parse(raw),records); }
    catch { try { articleRecords(JSON.parse(decodeEntities(raw)),records); } catch { /* invalid structured data */ } }
  }
  // KAP streams its disclosure inside React's temporary hidden S:n wrapper.
  // Select the known disclosure root first; removing hidden ancestors would
  // discard the actual source before the browser reveals the streamed HTML.
  if (target?.type === 'kap') {
    const roots=[...document.querySelectorAll('.disclosureScrollableArea')];
    if(roots.length===1) {
      const root=roots[0].cloneNode(true) as Element;
      root.querySelectorAll(NOISE).forEach(el=>el.remove());
      // KAP includes hidden English duplicates and taxonomy placeholders.
      // Only remove explicitly hidden descendants, never the stream wrapper.
      root.querySelectorAll('[style]').forEach(el=>{
        if(/(?:^|;)\s*display\s*:\s*none\s*(?:!important)?\s*(?:;|$)/i.test(el.getAttribute('style')??''))el.remove();
      });
      const source=readable(root);
      if(source.text.length>=20)return {...source,html:root.outerHTML};
    }
    throw new Error('Kaynağın ana metni güvenle ayrıştırılamadı; yalnız başlıktan taslak üretilmedi');
  }
  document.querySelectorAll(NOISE).forEach(el=>el.remove());
  const selectors = [
    '.page-content.print-container .icerik.styled-content',
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
    const source=readable(root);
    if (source.text.length >= 20) return {...source,html:root.outerHTML};
  }
  {
    const matched=target ? records.filter(record=>matchesTarget(record,target)) : records;
    const unique=[...new Map(matched.map(record=>[String(record.articleBody),record])).values()];
    if (unique.length===1) {
      const record=unique[0];
      const {document:fragment}=parseHTML(`<article>${String(record.articleBody)}</article>`);
      fragment.querySelectorAll(NOISE).forEach(el=>el.remove());
      const source=readable(fragment.firstElementChild!);
      if (source.text.length>=20) return {...source,html:fragment.firstElementChild!.outerHTML};
    }
  }
  throw new Error('Kaynağın ana metni güvenle ayrıştırılamadı; yalnız başlıktan taslak üretilmedi');
}
