import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { database } from './db-harness';
import { extractReaderContent, readerContent } from '../src/reader/content';
import { api } from '../src/api/routes';
let sql,env;
const item = {id:1,type:'news',title:'Haber',body:'Özet',url:'https://www.haberturk.com/test',source:'Habertürk',source_ref:'rss:1'};
beforeEach(()=>{
  ({sql,env}=database());
  sql.prepare("INSERT INTO feed_items(id,type,source,source_ref,title,body,url) VALUES (1,'news','Habertürk','rss:1','Haber','Özet','https://www.haberturk.com/test')").run();
});
afterEach(()=>{sql.close();vi.unstubAllGlobals();});
const response = html => new Response(html,{headers:{'content-type':'text/html'}});
describe('reader extraction',()=>{
  it('preserves paragraphs without chrome, scripts or recommendations',()=>{
    const result=extractReaderContent('<nav>Menü</nav><div class="article-body"><h2>Ayrıntılar</h2><p>Birinci &amp; ikinci.</p><script>alert(1)</script><p>Son paragraf.</p><aside>Başka haber</aside></div>',item);
    expect(result.blocks).toEqual([{type:'heading',text:'Ayrıntılar'},{type:'paragraph',text:'Birinci & ikinci.'},{type:'paragraph',text:'Son paragraf.'}]);
  });
  it('keeps every KAP table row including repeated values and nested layout tables',()=>{
    const result=extractReaderContent('<div class="disclosureScrollableArea"><table><tr><td><p>Açıklama</p><table><tr><td>Tutar</td><td>1.250 TL</td></tr><tr><td>Tutar</td><td>1.250 TL</td></tr></table></td></tr></table></div>',{...item,type:'kap'});
    expect(result.blocks[0]).toEqual({type:'paragraph',text:'Açıklama'});
    expect(result.blocks[1].rows.map(row=>row.map(cell=>cell.text))).toEqual([['Tutar','1.250 TL'],['Tutar','1.250 TL']]);
  });
  it('preserves merged cells instead of shifting financial table columns',()=>{
    const result=extractReaderContent('<div class="disclosureScrollableArea"><table><tr><th colspan="2">2026</th></tr><tr><td rowspan="2">Tutar</td><td>10</td></tr><tr><td>20</td></tr></table></div>',{...item,type:'kap'});
    expect(result.blocks[0].rows[0][0]).toMatchObject({colSpan:2,header:true});
    expect(result.blocks[0].rows[1][0]).toMatchObject({rowSpan:2,text:'Tutar'});
  });
  it('uses JSON-LD articleBody only, never description or the entire page',()=>{
    expect(extractReaderContent('<main>Cookie banner</main><script type="application/ld+json">{"description":"Just a teaser"}</script>',item)).toBeNull();
    const result=extractReaderContent('<script type="application/ld+json">{"@graph":[{"articleBody":"Açıklama metni."}]}</script>',item);
    expect(result.blocks[0].text).toBe('Açıklama metni.');
  });
});
describe('reader API and caching',()=>{
  it('reuses durable cache and does not fetch for each opening',async()=>{
    const fetchMock=vi.fn(async()=>response('<div class="cms-container"><p>İçerik.</p></div>'));vi.stubGlobal('fetch',fetchMock);
    const first=await readerContent(env,item);const second=await readerContent(env,item);
    expect(second).toEqual(first);expect(first.status).toBe('content');expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('invalidates changed summaries, and leases prevent concurrent duplicate fetches',async()=>{
    let release;vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{release=r;})));
    const first=readerContent(env,item);
    await vi.waitFor(()=>expect(release).toBeDefined());
    expect(await readerContent(env,item)).toBeNull();
    release(response('<div class="cms-container"><p>Metin.</p></div>'));await first;
    vi.stubGlobal('fetch',vi.fn(async()=>response('<div class="cms-container"><p>Yeni metin.</p></div>')));
    const updated=await readerContent(env,{...item,body:'Yeni özet'});expect(updated.blocks[0].text).toBe('Yeni metin.');
  });
  it('does not follow redirects to untrusted or local hosts, caches a clearly labelled summary',async()=>{
    const fetchMock=vi.fn(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}));vi.stubGlobal('fetch',fetchMock);
    const result=await readerContent(env,item);expect(result.status).toBe('summary');expect(result.blocks[0].text).toBe('Özet');
    await readerContent(env,item);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('validates IDs, disallows DKB, and exposes only stored feed URLs',async()=>{
    expect((await api(new Request('https://app/api/content?id=oops'),env)).status).toBe(400);
    expect((await api(new Request('https://app/api/content?id=999'),env)).status).toBe(404);
    sql.prepare("UPDATE feed_items SET type='kap',title='Devre kesici uygulaması' WHERE id=1").run();
    expect((await api(new Request('https://app/api/content?id=1'),env)).status).toBe(422);
  });
});
