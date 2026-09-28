import { parseHTML } from 'linkedom';
import { decodeEntities } from '../utils/text';
import type { Env } from '../types';
import { parseRss } from '../rss/parser';
import { fetchWithTimeout } from '../utils/http';
import { ingestPosts, type XPost } from './feed';

export class XPollError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); }
}

export function parseNitterFeed(xml: string, account: string): XPost[] {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) throw new Error('X RSS geçerli değil; giriş veya erişim engeli olabilir.');
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  if (!blocks.length) throw new Error('X RSS boş; başarılı tarama kabul edilmedi.');
  return blocks.flatMap(block => {
    const item = parseRss(`<rss><channel>${block}</channel></rss>`)[0];
    if (!item) return [];
    const match = new URL(item.url).pathname.match(/^\/([a-zA-Z0-9_]+)\/status\/(\d+)\/?$/);
    // Reposts by other accounts and replies must not be attributed to this account.
    if (!match || match[1].toLowerCase() !== account || !item.publishedAt || /^(RT\s|R to\s|R @)/i.test(item.title)) return [];
    const description = block.match(/<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i)?.[1];
    if (!description) throw new Error('X RSS tam paylaşım metni bulunamadı.');
    const { document } = parseHTML(`<div>${decodeEntities(description).replace(/<br\s*\/?>/gi,'\n')}</div>`);
    const root = document.firstElementChild!;
    root.querySelectorAll('script,style').forEach(el => el.remove());
    const paragraph = root.querySelector('p');
    const ownText = paragraph && !paragraph.closest('blockquote') ? paragraph.textContent?.trim() : null;
    if (!ownText) throw new Error('X RSS tam paylaşım metni bulunamadı.');
    const quote = root.querySelector('blockquote');
    const quoteAuthor = quote?.querySelector('b')?.textContent?.trim();
    const quoteText = quote?.querySelector('p')?.textContent?.trim();
    const text = ownText + (quoteText && quoteAuthor ? `\n\nAlıntılanan paylaşım — ${quoteAuthor}:\n${quoteText}` : '');
    return [{id:match[2],text,publishedAt:item.publishedAt}];
  });
}

export async function pollXAccount(env: Env, account: string): Promise<void> {
  if (!env.X_NITTER_BASE_URL) return;
  const base = new URL(env.X_NITTER_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') throw new Error('X_NITTER_BASE_URL HTTPS origin olmalı.');
  const url = new URL(`/${account}/rss`, base).href;
  const response = await fetchWithTimeout(url, {headers:{accept:'application/rss+xml,application/xml', 'user-agent':'HeranBorsa/1.0 RSS reader'},redirect:'manual'},15_000);
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
    await response.body?.cancel();
    throw new XPollError(`X RSS HTTP ${response.status}`, Number.isFinite(seconds) ? Math.max(0,seconds) : 0);
  }
  const xml = await response.text();
  if (xml.length > 1_000_000) throw new Error('X RSS çok büyük.');
  const posts = parseNitterFeed(xml,account);
  if (!posts.length) throw new Error('X RSS içinde hesap sahibine ait geçerli paylaşım yok.');
  await ingestPosts(env,account,posts);
}
