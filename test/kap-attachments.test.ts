import {it,expect,vi} from 'vitest';
import {kapAttachments} from '../src/ai/kap-attachments';
import {fetchSourceBundle} from '../src/ai/content';
import type {FeedItem} from '../src/types';
const url='https://www.kap.org.tr/tr/Bildirim/1669095';
const row={objId:'4028328ca0b8418601a0e87f17566c7a',fileName:'HEDEF.pdf',fileExtension:'pdf'};
const flight=(text:string)=>`<script>self.__next_f.push(${JSON.stringify([1,text])})</script>`;
function page(count=1,attachments:unknown[]=[row],id=1669095){
  const data=JSON.stringify({disclosureBasic:{disclosureIndex:id,attachmentCount:count},attachments});
  return `<div hidden id="S:3"><div class="disclosureScrollableArea"><p>Açıklama ekte yer almaktadır. İçerik MKK tarafından teyit edilmemiştir.</p></div></div><aside><a href="/unrelated.pdf">Başka rapor.pdf</a></aside>`+flight(data);
}
it('finds the disclosure PDF outside the article and excludes unrelated/print links',()=>{
  const files=kapAttachments(page()+`<a href="/tr/api/BildirimPdf/1669095">Bildirimi yazdır</a>`,url);
  expect(files).toEqual([{url:'https://www.kap.org.tr/tr/api/file/download/'+row.objId,filename:'HEDEF.pdf',isPdf:true}]);
});
it('handles split streamed data, repeated attachment lists and escaped filenames',()=>{
  const attachment={...row,fileName:'HEDEF [rev] "TR".pdf'};
  const data=JSON.stringify({disclosureBasic:{disclosureIndex:1669095,attachmentCount:1},attachments:[attachment]})+'\n'+JSON.stringify({attachments:[attachment]});
  expect(kapAttachments(flight(data.slice(0,80))+flight(data.slice(80)),url)?.[0].filename).toBe(attachment.fileName);
});
it('rejects mismatched IDs, missing or extra attachments and unsafe file IDs',()=>{
  expect(()=>kapAttachments(page(1,[],9),url)).toThrow('kimliği');
  expect(()=>kapAttachments(page(1,[]),url)).toThrow('eksik');
  expect(()=>kapAttachments(page(0,[row]),url)).toThrow('eksik');
  expect(()=>kapAttachments(page(1,[{...row,objId:'https://other.example/file'}]),url)).toThrow('doğrulanamadı');
  expect(kapAttachments(page(0,[]),url)).toEqual([]);
});
it('leaves non-KAP sites and absent structured data to scoped article extraction',()=>{
  expect(kapAttachments(page(),'https://other.example/tr/Bildirim/1669095')).toBeNull();
  expect(kapAttachments('<article>Normal metin</article>',url)).toBeNull();
});
it('includes the official PDF in the actual source bundle rather than only the cover note',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(page(),{headers:{'content-type':'text/html'}})));
  try{
    const source=await fetchSourceBundle({id:1,type:'kap',source:'KAP',source_ref:'kap:1669095',title:'Özel Durum Açıklaması (Genel)',body:'KAMUYU AYDINLATMA PLATFORMU',url,tickers_json:'["HEDEF"]',published_at:'2026-09-28T14:54:28Z',created_at:'2026-09-28T14:56:00Z'} satisfies FeedItem);
    expect(source.text).toContain('teyit edilmemiştir');expect(source.attachments[0].filename).toBe('HEDEF.pdf');expect(source.attachments).toHaveLength(1);
  }finally{vi.unstubAllGlobals();}
});
