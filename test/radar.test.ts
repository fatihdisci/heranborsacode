import {describe,it,expect,vi,afterEach} from 'vitest';
import {SOURCES} from '../src/sources/registry';
import {classify} from '../src/sources/filter';
import {parseResets} from '../src/sources/resets';
import {notificationText,pollSource} from '../src/sources/poll';
import {normalizeUrl} from '../src/utils/text';
// The D1 harness is JavaScript because it uses Node's in-memory SQLite.
// @ts-ignore Node SQLite test harness has no TypeScript declarations.
import {database} from './db-harness.js';
afterEach(()=>vi.unstubAllGlobals());
describe('AI source registry and decisions',()=>{
 it('has unique independent sources and attribution for resets',()=>{expect(new Set(SOURCES.map(s=>s.id)).size).toBe(SOURCES.length);expect(SOURCES.find(s=>s.id==='codex-resets')?.attribution?.url).toBe('https://codex-resets.com/');});
 it('keeps international AI editorial feeds in the app without alert spam',()=>{
  for(const id of ['techcrunch-ai','verge-ai','mit-review-ai','huggingface-blog']) {
   const source=SOURCES.find(s=>s.id===id);
   expect(source?.kind).toBe('rss');
   expect(source?.category).toBe('ai-news');
   expect(classify(source!,'New GPT-7 model released').priority).toBe('normal');
  }
 });
 it('filters low-value PR and keeps model/limit changes',()=>{const s=SOURCES[0];expect(classify(s,'Customer story webinar').priority).toBe('ignore');expect(classify(s,'Introducing GPT-7 model').priority).toBe('high');expect(classify(s,'Codex usage limits changed').classification).toBe('limits');});
 it('normalizes tracking links for cross-source dedupe',()=>expect(normalizeUrl('https://example.com/a/?utm_source=x#top')).toBe(normalizeUrl('https://example.com/a')));
 it('parses reset IDs and rejects malformed rows',()=>{const data={data:[{id:'42',reset_type:'banked',announced_at:'2026-09-22T10:00:00Z',text:'Reset announced',source:{url:'https://x.com/a/status/42'}},{id:1}]};expect(parseResets(data)).toHaveLength(1);expect(parseResets(data)[0].url).toContain('x.com');expect(()=>parseResets({})).toThrow();});
 it('escapes Telegram text',()=>{const s=SOURCES[0];expect(notificationText(s,{title:'<Model>',summary:'A & B',url:'https://example.com',publishedAt:null})).toContain('&lt;Model&gt;');});
});
describe('polling',()=>{
 it('seeds silently, inserts fresh high priority once, and deduplicates repeats',async()=>{
  const {sql,env}=database();const s=SOURCES.find(x=>x.id==='openai-news')!;
  let title='Introducing GPT-7 model';
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(`<rss><channel><item><title>${title}</title><description>New model for Codex</description><link>https://openai.com/news/gpt7</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,{headers:{'content-type':'application/rss+xml'}})));
  await pollSource(env as any,s);
  expect(sql.prepare('SELECT count(*) n FROM telegram_outbox').get().n).toBe(0);
  title='Introducing GPT-8 model';
  await pollSource(env as any,s);await pollSource(env as any,s);
  expect(sql.prepare('SELECT count(*) n FROM telegram_outbox').get().n).toBe(1);
  expect(sql.prepare("SELECT count(*) n FROM feed_items WHERE category='openai'").get().n).toBe(2);
 });
 it('deduplicates reset records while reading status',async()=>{
  const {sql,env}=database();const s=SOURCES.find(x=>x.id==='codex-resets')!;
  const reset={data:[{id:'42',reset_type:'regular',announced_at:new Date().toISOString(),text:'Reset all propagated',source:{url:'https://x.com/a/status/42'}}]};
  vi.stubGlobal('fetch',vi.fn(async(url)=>new Response(JSON.stringify(String(url).endsWith('/status')?{data:{latest_reset:reset.data[0]}}:reset),{headers:{'content-type':'application/json'}})));
  await pollSource(env as any,s);await pollSource(env as any,s);
  expect(sql.prepare("SELECT count(*) n FROM feed_items WHERE category='resets'").get().n).toBe(1);
  expect(sql.prepare('SELECT count(*) n FROM telegram_outbox').get().n).toBe(0);
 });
});
