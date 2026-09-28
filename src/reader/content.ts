import { parseHTML } from 'linkedom';
import type { Env, FeedItem } from '../types';
import { extractAttachments, type SourceAttachment } from '../ai/content';
import { sha256 } from '../utils/text';

export interface ReaderCell { text: string; rowSpan: number; colSpan: number; header: boolean; }
export type ReaderBlock = { type: 'paragraph' | 'heading'; text: string } | { type: 'table'; rows: ReaderCell[][] };
export interface ReaderContent {
  status: 'content' | 'summary'; blocks: ReaderBlock[]; attachments: SourceAttachment[];
  notice: string | null; fetchedAt: string;
}
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const hosts = ['kap.org.tr', 'foreks.com', 'bloomberght.com', 'investing.com', 'haberturk.com', 'sozcu.com.tr'];
function allowed(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); }
  catch { return false; }
}

export function extractReaderContent(html: string, item: FeedItem): Omit<ReaderContent, 'fetchedAt'> | null {
  const { document } = parseHTML(html);
  const structured: string[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.articleBody === 'string') structured.push(obj.articleBody);
    for (const value of Object.values(obj)) if (typeof value === 'object') visit(value);
  }
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(el.textContent || '')); } catch { /* malformed publisher data */ }
  }
  const selector = item.type === 'kap' ? '.disclosureScrollableArea' : '[itemprop="articleBody"], .article-body, .cms-container, .news-detail-content, .news-content';
  const roots = [...document.querySelectorAll(selector)].filter(el => !el.parentElement?.closest(selector));
  const blocks: ReaderBlock[] = [];
  let pending = '';
  function flush(type: 'paragraph' | 'heading' = 'paragraph') {
    const text = clean(pending); pending = '';
    if (text) blocks.push({ type, text });
  }
  function walk(node: Node) {
    if (node.nodeType === 3) { pending += node.textContent || ''; return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (/^(script|style|noscript|svg|nav|aside|button|form|iframe)$/.test(tag) || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || /(?:^|\s)(?:advertisement|related-news|social-share|ad-container)(?:\s|$)/.test(el.className)) return;
    if (tag === 'table' && !el.querySelector('table')) {
      flush();
      const span = (cell: Element, name: string) => Math.max(1, Math.min(1000, Number.parseInt(cell.getAttribute(name) || '1', 10) || 1));
      const rows = [...el.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => ({text: clean(cell.textContent || ''), rowSpan: span(cell,'rowspan'), colSpan: span(cell,'colspan'), header: cell.tagName.toLowerCase() === 'th'})));
      if (rows.length) blocks.push({ type: 'table', rows });
      return;
    }
    const boundary = /^(p|div|section|br|li|h[1-6]|tr)$/.test(tag);
    if (boundary) flush();
    for (const child of el.childNodes) walk(child);
    if (boundary) flush(/^h[1-6]$/.test(tag) ? 'heading' : 'paragraph');
  }
  roots.forEach(root => { walk(root); flush(); });
  // JSON-LD is a fallback only: never use the whole page (navigation, recommendations, ads).
  if (!blocks.length && item.type === 'news') {
    const body = structured.sort((a,b) => b.length - a.length)[0];
    if (body) {
      const { document: fragment } = parseHTML(`<div>${body}</div>`);
      walk(fragment.firstElementChild!); flush();
    }
  }
  const length = JSON.stringify(blocks).length;
  if (!blocks.length || length > 500_000) return null;
  return { status: 'content', blocks, attachments: extractAttachments(html, item.url).filter(a => allowed(a.url)), notice: 'Kaynak sayfanın erişilebilir metni. Görseller ve ek dosyalar metne dahil değildir.' };
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    for (let i = 0; i < 4; i++) {
      if (!allowed(url)) throw new Error('unsupported_source');
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; HeranBorsa/1.0)' } });
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        url = new URL(response.headers.get('location') || '', url).href; continue;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) { await response.body?.cancel(); throw new Error('source_unavailable'); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('empty_source');
      const decoder = new TextDecoder(); let html = '', bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 3_000_000) { await reader.cancel(); throw new Error('source_too_large'); }
        html += decoder.decode(value, { stream: true });
      }
      return html + decoder.decode();
    }
    throw new Error('redirect_limit');
  } finally { clearTimeout(timer); }
}

export async function readerContent(env: Env, item: FeedItem): Promise<ReaderContent | null> {
  const key = await sha256(JSON.stringify(['reader-v2', item.url, item.title, item.body]));
  const now = Date.now();
  const cached = await env.DB.prepare('SELECT payload FROM reader_cache WHERE feed_item_id=? AND cache_key=? AND expires_at>?').bind(item.id, key, now).first<{payload:string}>();
  if (cached?.payload) return JSON.parse(cached.payload);
  // Cross-isolate lease prevents repeated taps/users from fetching the same source concurrently.
  const claim = await env.DB.prepare(`INSERT INTO reader_cache(feed_item_id,cache_key,lease_until,expires_at) VALUES (?,?,?,0)
    ON CONFLICT(feed_item_id) DO UPDATE SET cache_key=excluded.cache_key,lease_until=excluded.lease_until
    WHERE reader_cache.lease_until<?`).bind(item.id, key, now + 30_000, now).run();
  if (!claim.meta.changes) return null;
  let content: ReaderContent;
  try {
    const extracted = extractReaderContent(await fetchHtml(item.url), item);
    if (!extracted) throw new Error('no_article_body');
    content = { ...extracted, fetchedAt: new Date().toISOString() };
  } catch {
    content = { status: 'summary', blocks: item.body ? [{ type: 'paragraph', text: item.body }] : [], attachments: [], notice: 'Tam metin şu anda alınamadı. Varsa kayıtlı özet gösteriliyor; içeriğin tamamı için kaynağa gidebilirsin.', fetchedAt: new Date().toISOString() };
  }
  await env.DB.prepare('UPDATE reader_cache SET payload=?,expires_at=?,lease_until=0 WHERE feed_item_id=? AND cache_key=?')
    .bind(JSON.stringify(content), Date.now() + (content.status === 'content' ? 3_600_000 : 120_000), item.id, key).run();
  return content;
}
