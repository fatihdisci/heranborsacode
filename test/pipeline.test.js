import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { database } from './db-harness';
import { pollRSSSource } from '../src/rss/poll';
import { generateTweetDraft } from '../src/ai/tweet';
import { enqueueStatement,flushCircuitBreakers,deliverOne } from '../src/telegram/outbox';
import otkarSource from './fixtures/otkar-contract.json';
let sql,env;
beforeEach(()=>{({sql,env}=database());});
afterEach(()=>{sql.close();vi.unstubAllGlobals();});
const source={name:'Test Ekonomi',url:'https://example.com/rss'};
function rss(amount,date=new Date()) {return `<rss><channel><item><title>Vestel yeni sözleşme imzaladı</title><link>https://example.com/news/1</link><description>Vestel, ${amount} milyon TL tutarında yeni sözleşme imzaladı.</description><pubDate>${date.toUTCString()}</pubDate></item></channel></rss>`;}
it('handles RSS revisions and repeated polls without sending Telegram during ingestion',async()=>{
  sql.prepare("INSERT INTO system_state(key,value) VALUES (?,'1')").run('rss_baseline:'+source.url);
  let amount=10;
  const mock=vi.fn(async(url)=>{expect(url).toBe(source.url);return new Response(rss(amount));});
  vi.stubGlobal('fetch',mock);
  await pollRSSSource(env,source);await pollRSSSource(env,source);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(1);
  amount=20;await pollRSSSource(env,source);await pollRSSSource(env,source);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(2);
  expect(sql.prepare('SELECT count(*) AS n FROM feed_items').get().n).toBe(2);
});
it('keeps late RSS items in the Mini App without sending old news to Telegram',async()=>{
  sql.prepare("INSERT INTO system_state(key,value) VALUES (?,'1')").run('rss_baseline:'+source.url);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(rss(10,new Date(Date.now()-2*60*60_000)))));
  await pollRSSSource(env,source);
  expect(sql.prepare('SELECT count(*) AS n FROM feed_items').get().n).toBe(1);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(0);
  expect(sql.prepare('SELECT telegram_status FROM rss_items').get().telegram_status).toBe('baseline');
});
it('rolls back source and feed when delivery persistence fails',async()=>{
  sql.prepare("INSERT INTO system_state(key,value) VALUES (?,'1')").run('rss_baseline:'+source.url);
  sql.exec("CREATE TRIGGER reject_queue BEFORE INSERT ON telegram_outbox BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(rss(10))));
  await expect(pollRSSSource(env,source)).rejects.toThrow();
  expect(sql.prepare('SELECT count(*) AS n FROM rss_items').get().n).toBe(0);
  expect(sql.prepare('SELECT count(*) AS n FROM feed_items').get().n).toBe(0);
});
it('upgrades only pending legacy messages and preserves sent/baseline records',()=>{
  sql.close();({sql,env}=database({queueMigration:false}));
  for(const [id,status] of [['1','pending'],['2','sent'],['3','baseline']]) {
    sql.prepare("INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,telegram_status) VALUES (?,'Pay Bazında Devre Kesici Bildirimi','https://example.com',?,?)").run(id,id,status);
    sql.prepare("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('kap','KAP',?,'Pay Bazında Devre Kesici Bildirimi','https://example.com','[\"THYAO\"]')").run('kap:'+id);
  }
  sql.prepare("INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,telegram_status) VALUES ('4','Kayıp bildirim','https://example.com','4','pending')").run();
  sql.exec(readFileSync('migrations/0005_delivery_outbox.sql','utf8'));
  const rows=sql.prepare('SELECT id,status,kind FROM telegram_outbox').all();
  expect(rows).toHaveLength(2);expect(rows.find(row=>row.id==='kap:1')).toMatchObject({status:'buffered',kind:'dkb'});
  expect(sql.prepare("SELECT title FROM feed_items WHERE source_ref='kap:4'").get().title).toBe('Kayıp bildirim');
});
it('groups 100 DKBs into one accepted message and preserves all references',async()=>{
  const seen=new Date(Date.now()-13000).toISOString();
  for(let i=0;i<100;i++) await enqueueStatement(env,'kap:'+i,'dkb',{codes:['A'+String(i).padStart(4,'0')]},null,seen).run();
  await flushCircuitBreakers(env);
  const mock=vi.fn(async(_url,init)=>{expect(init.body.get('text').match(/#/g)).toHaveLength(100);expect(init.body.get('text').length).toBeLessThan(4096);return new Response(JSON.stringify({ok:true,result:{message_id:99}}));});
  vi.stubGlobal('fetch',mock);await deliverOne(env);
  expect(sql.prepare("SELECT count(*) AS n FROM telegram_outbox WHERE status='sent' AND source_ref IS NOT NULL").get().n).toBe(100);
  expect(mock).toHaveBeenCalledTimes(1);
});
function modelResponse(body,status='completed') {return new Response(JSON.stringify({status,output_text:JSON.stringify({status:'ready',body})}));}
function newsItem() {
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('news','Test','rss:direct','Şirketin yeni sözleşmesi','https://example.com/news','[\"VESTL\"]')");
  return sql.prepare('SELECT * FROM feed_items').get();
}
it('sends full source and title directly in one call without fact or numeric gates',async()=>{
  const item=newsItem();let calls=0;
  const sourceText='Şirket 2 milyon avroluk sözleşme imzaladı. İşin tamamlanması resmi onaya bağlı.';
  const body='Şirketten 2 milyon avroluk sözleşme\n\nŞirket yeni sözleşmeye imza attı. İşin tamamlanması resmi onaya bağlı.';
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response(`<article>${sourceText}</article>`,{headers:{'content-type':'text/html'}});
    calls++;const request=JSON.parse(init.body),input=JSON.parse(request.input[0].content[0].text);
    expect(request.model).toBe('gpt-6-luna');expect(request.reasoning.effort).toBe('medium');
    expect(request.text.format.schema.required).toEqual(['status','body']);
    expect(input.target.title).toBe(item.title);expect(input.target.url).toBe(item.url);
    expect(input.sourceText).toContain(sourceText);expect(input.sourceDocument.passages[0].text).toBe(sourceText);
    expect(request.instructions).toContain('280 karaktere sığdırmak veya kısa yazmak zorunda değilsin');
    return modelResponse(body);
  }));
  expect(await generateTweetDraft({...env,OPENAI_API_KEY:'test-key'},item)).toEqual({tweet:`#VESTL\n\n${body}`,cached:false});
  expect(calls).toBe(1);
  expect(JSON.parse(sql.prepare('SELECT evidence_json FROM ai_tweet_drafts').get().evidence_json)).toMatchObject({mode:'direct'});
});
it('includes the official KAP issuer and disclosure text directly in the draft request',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('kap','KAP','kap:1670620','Özel Durum Açıklaması (Genel)','https://www.kap.org.tr/tr/Bildirim/1670620','[\"OTKAR\"]')");
  const item=sql.prepare('SELECT * FROM feed_items').get();
  const issuer=otkarSource.document.passages.find(p=>p.id==='kap-issuer').text;
  const sourceText=otkarSource.document.passages.find(p=>p.text.startsWith('Şirketimiz, çeşitli tiplerde')).text;
  const stream=JSON.stringify([1,JSON.stringify({disclosureBasic:{disclosureIndex:1670620,attachmentCount:0,companyTitle:issuer},attachments:[]})]);let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response(`<div class="disclosureScrollableArea"><p>${sourceText}</p></div><script>self.__next_f.push(${stream})</script>`,{headers:{'content-type':'text/html'}});
    calls++;const input=JSON.parse(JSON.parse(init.body).input[0].content[0].text);
    expect(input.sourceDocument.passages).toContainEqual(expect.objectContaining({id:'kap-issuer',text:issuer}));
    expect(input.sourceText).toContain(sourceText);
    return modelResponse('Otokar yeni ihracat sözleşmesi imzaladı.');
  }));
  expect((await generateTweetDraft({...env,OPENAI_API_KEY:'test-key'},item)).tweet).toContain('#OTKAR');expect(calls).toBe(1);
});
it.each(['api','incomplete','empty','insufficient','invalid_json'])('does not cache or automatically retry a %s response',async failure=>{
  const item=newsItem();let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    if(url===item.url)return new Response('<article>Şirket yeni sözleşme imzaladı.</article>',{headers:{'content-type':'text/html'}});
    calls++;
    if(failure==='api')return new Response('',{status:503});
    if(failure==='incomplete')return modelResponse('Şirket','incomplete');
    if(failure==='empty')return modelResponse('');
    return new Response(JSON.stringify({status:'completed',output_text:failure==='invalid_json'?'invalid':JSON.stringify({status:'insufficient',body:''})}));
  }));
  await expect(generateTweetDraft({...env,OPENAI_API_KEY:'test-key'},item)).rejects.toThrow();
  expect(calls).toBe(1);expect(sql.prepare('SELECT count(*) n FROM ai_tweet_drafts').get().n).toBe(0);
});
it('passes revision instructions and previous draft directly while preserving the normal cache',async()=>{
  const item=newsItem(),configured={...env,OPENAI_API_KEY:'test-key'};let calls=0;
  const bodies=['Sözleşme imzalandı.','Şirket yeni bir sözleşmeye imza attı.','Yeni sözleşme\n\nŞirket sözleşmeye imza attı.'];
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response('<article>Şirket yeni sözleşme imzaladı.</article>',{headers:{'content-type':'text/html'}});
    const request=JSON.parse(init.body),input=JSON.parse(request.input[0].content[0].text);
    if(calls===2) {
      expect(request.instructions).toContain('KULLANICININ EK TALİMATI\nBaşlığı ayrı satıra al.');
      expect(input.revision).toEqual({requested:true,instruction:'Başlığı ayrı satıra al.',previousDraft:bodies[1]});
    }
    return modelResponse(bodies[calls++]);
  }));
  await generateTweetDraft(configured,item);
  expect((await generateTweetDraft(configured,item)).cached).toBe(true);
  expect((await generateTweetDraft(configured,item,{regenerate:true})).tweet).toContain(bodies[1]);
  expect((await generateTweetDraft(configured,item,{instruction:'Başlığı ayrı satıra al.',previousDraft:bodies[1]})).tweet).toContain(bodies[2]);
  expect((await generateTweetDraft(configured,item)).tweet).toContain(bodies[1]);expect(calls).toBe(3);
});
it('rereads changed source and never falls back to a headline-only draft',async()=>{
  const item=newsItem(),configured={...env,OPENAI_API_KEY:'test-key'};let html='<article>Şirket kredi limiti için başvurdu.</article>',calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    if(url===item.url)return new Response(html,{headers:{'content-type':'text/html'}});
    calls++;return modelResponse(calls===1?'Şirket kredi limiti için başvurdu.':'Şirketin kredi limiti onaylandı.');
  }));
  await generateTweetDraft(configured,item);html='<article>Şirketin kredi limiti onaylandı.</article>';
  expect((await generateTweetDraft(configured,item)).cached).toBe(false);expect(calls).toBe(2);
  html='<h1>Şirketin kredi limiti onaylandı.</h1>';
  await expect(generateTweetDraft(configured,item)).rejects.toThrow('ana metni');expect(calls).toBe(2);
});
it('sends PDF attachments to the same model call without reusing URL-only caches',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url) VALUES ('spk','SPK','spk:pdf','Bülten','https://example.com/bulten.pdf')");
  const item=sql.prepare('SELECT * FROM feed_items').get();let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response('PDF',{headers:{'content-type':'application/pdf'}});
    calls++;const content=JSON.parse(init.body).input[0].content;
    expect(content[2]).toEqual({type:'input_file',file_url:item.url,detail:'high'});
    return modelResponse('SPK başvuruyu onayladı.');
  }));
  const configured={...env,OPENAI_API_KEY:'test-key'};
  await generateTweetDraft(configured,item);expect((await generateTweetDraft(configured,item)).cached).toBe(false);expect(calls).toBe(2);
});
it('passes an X post as attributed source data in a single call',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,body,url) VALUES ('news','X @test','x:1','İşlem iddiası','Şirketin işlem yapacağı iddia edildi.','https://example.com/x')");
  const item=sql.prepare('SELECT * FROM feed_items').get();
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
    const input=JSON.parse(JSON.parse(init.body).input[0].content[0].text);
    expect(input.source.kind).toBe('x-post');expect(input.sourceText).toContain(item.body);
    return modelResponse('X hesabının paylaşımında şirketin işlem yapacağı iddia edildi.');
  }));
  await generateTweetDraft({...env,OPENAI_API_KEY:'test-key'},item);expect(fetch).toHaveBeenCalledTimes(1);
});
