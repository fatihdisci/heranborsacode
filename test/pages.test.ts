import {it,expect,vi,afterEach} from 'vitest';
import {parseSitemap,pageCandidates} from '../src/sources/pages';
import {SOURCES} from '../src/sources/registry';
afterEach(()=>vi.unstubAllGlobals());
it('limits Anthropic sitemap entries to official news URLs',()=>{
 const xml='<urlset><url><loc>https://www.anthropic.com/news/claude-model</loc><lastmod>2026-09-24T10:00:00Z</lastmod></url><url><loc>https://evil.test/news/fake</loc><lastmod>2026-09-24T10:00:00Z</lastmod></url></urlset>';
 expect(parseSitemap(xml,'www.anthropic.com')).toEqual([{url:'https://www.anthropic.com/news/claude-model',modified:'2026-09-24T10:00:00Z'}]);
});
it('reads current Cursor changelog metadata without following other hosts',async()=>{
 const source=SOURCES.find(s=>s.id==='cursor-changelog')!;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(`<html><head><meta property="og:title" content="Cursor coding agents"><meta name="description" content="New agent feature"></head><body><time dateTime="${new Date().toISOString()}">Now</time></body></html>`)));
 const listing='<a href="/changelog/new-agents">New agents</a><a href="https://evil.test/changelog/fake">Bad</a>';
 const items=await pageCandidates(source,listing);
 expect(items).toHaveLength(1);expect(items[0].url).toBe('https://cursor.com/changelog/new-agents');
});
