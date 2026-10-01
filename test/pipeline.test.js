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
function analysisOutput(sourceText,facts=[],sourceId='p1') {
  return {status:'ready',event:{kind:'other',stage:sourceText.includes('başvurdu')?'application':sourceText.includes('onaylandı')||sourceText.includes('onayladı')?'approval':'executed',direction:'none',actor:null,subject:null,summary:sourceText,eventDate:null,evidence:[{sourceId,quote:sourceText,location:sourceId.startsWith('attachment-')?'Sayfa 1':null}]},facts,ambiguities:[]};
}
function draftOutput(body,usedFactIds=[],numericClaims=[]) {return {status:'ready',body,usedFactIds,numericClaims};}
function modelResponse(output,status='completed') {return new Response(JSON.stringify({status,output_text:JSON.stringify(output)}));}
it('carries a resolved first-person KAP issuer into the writer and cache without a repair call',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('kap','KAP','kap:1670620','Özel Durum Açıklaması (Genel)','https://www.kap.org.tr/tr/Bildirim/1670620','[\"OTKAR\"]')");
  const item=sql.prepare('SELECT * FROM feed_items').get();
  const issuer=otkarSource.document.passages.find(p=>p.id==='kap-issuer').text;
  const sourceText=otkarSource.document.passages.find(p=>p.text.startsWith('Şirketimiz, çeşitli tiplerde')).text;
  const stream=JSON.stringify([1,JSON.stringify({disclosureBasic:{disclosureIndex:1670620,attachmentCount:0,companyTitle:issuer},attachments:[]})]);
  const calls=[];
  const body='Otokar, tekerlekli zırhlı araç tedariki ve entegre lojistik destek için ihracat sözleşmesi imzaladı. Yürürlüğe girmesi resmî onay, teminat işlemleri ve avans ödemesine bağlı.';
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response(`<div class="disclosureScrollableArea"><p>${sourceText}</p></div><script>self.__next_f.push(${stream})</script>`,{headers:{'content-type':'text/html'}});
    const request=JSON.parse(init.body);calls.push(request);
    if(request.text.format.name==='source_analysis')return modelResponse({
      ...analysisOutput(sourceText),event:{...analysisOutput(sourceText).event,actor:issuer,subject:issuer},
    });
    const evidence=JSON.parse(request.input[0].content[0].text);
    expect(evidence.supportingEvidence).toContainEqual(expect.objectContaining({id:'kap-issuer',text:issuer}));
    expect(evidence.verifiedEvent.evidence).toContainEqual({sourceId:'kap-issuer',quote:issuer,location:null});
    return modelResponse(draftOutput(body));
  }));
  expect(await generateTweetDraft({...env,OPENAI_API_KEY:'fake-test-key'},item)).toEqual({tweet:`#OTKAR\n\n${body}`,cached:false});
  expect(calls).toHaveLength(2);
  const audit=JSON.parse(sql.prepare('SELECT evidence_json FROM ai_tweet_drafts').get().evidence_json);
  expect(audit.analysis.event.evidence).toContainEqual({sourceId:'kap-issuer',quote:issuer,location:null});
  expect(audit.repairs).toEqual({analysis:false,writer:false});
});
it.each(['source_analysis','tweet_writer'])('repairs one invalid %s output with source evidence and records the repair',async phase=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('news','Test','rss:repair','Sözleşme','https://example.com/repair','[]')");
  const item=sql.prepare('SELECT * FROM feed_items').get();
  const sourceText='Şirket, 2 milyon avroluk sözleşme imzaladı.';
  const fact={id:'f1',meaning:'Tutar',value:'2 milyon avro',metric:'cash_amount',scope:'unknown',unit:'avro',transactionDate:null,evidence:[{sourceId:'p1',quote:'2 milyon avroluk sözleşme',location:null}]};
  const calls=[];
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response(`<article>${sourceText}</article>`,{headers:{'content-type':'text/html'}});
    const body=JSON.parse(init.body);calls.push(body);
    const current=body.text.format.name;
    const invalid=current===phase && calls.filter(call=>call.text.format.name===phase).length===1;
    if(current==='source_analysis')return modelResponse(analysisOutput(sourceText,[{...fact,value:invalid?'3 milyon avro':fact.value}]));
    return modelResponse(draftOutput(invalid?'Şirket, 3 milyon avroluk sözleşme imzaladı.':sourceText,['f1'],[{text:invalid?'3 milyon avroluk sözleşme':'2 milyon avroluk sözleşme',factId:'f1'}]));
  }));
  const result=await generateTweetDraft({...env,OPENAI_API_KEY:'fake-test-key'},item);
  expect(result.tweet).toBe(sourceText);expect(calls).toHaveLength(3);
  const correction=calls.filter(call=>call.text.format.name===phase)[1];
  expect(correction.instructions).toContain('DOĞRULAMA DÜZELTMESİ');
  expect(JSON.parse(correction.input[0].content.at(-1).text).validationError).toContain('Kaynak doğrulaması başarısız');
  const audit=JSON.parse(sql.prepare('SELECT evidence_json FROM ai_tweet_drafts').get().evidence_json);
  expect(audit.repairs).toEqual({analysis:phase==='source_analysis',writer:phase==='tweet_writer'});
});
it('stops after one unsuccessful correction and never caches an invalid draft',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url) VALUES ('news','Test','rss:bad-repair','Sözleşme','https://example.com/bad-repair')");
  const item=sql.prepare('SELECT * FROM feed_items').get();let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    if(url===item.url)return new Response('<article>Şirket sözleşme imzaladı.</article>',{headers:{'content-type':'text/html'}});
    calls++;return modelResponse(analysisOutput('Kaynakta olmayan olay.'));
  }));
  await expect(generateTweetDraft({...env,OPENAI_API_KEY:'fake-test-key'},item)).rejects.toThrow('alıntı kaynak');
  expect(calls).toBe(2);expect(sql.prepare('SELECT COUNT(*) n FROM ai_tweet_drafts').get().n).toBe(0);
});
it.each(['api_error','conflict','reject'])('does not retry %s as an evidence correction',async failure=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url) VALUES ('news','Test','rss:no-retry','Sözleşme','https://example.com/no-retry')");
  const item=sql.prepare('SELECT * FROM feed_items').get();let calls=0;
  const sourceText='Şirket sözleşme imzaladı.';
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response(`<article>${sourceText}</article>`,{headers:{'content-type':'text/html'}});
    calls++;
    if(failure==='api_error')return new Response('upstream unavailable',{status:503});
    if(JSON.parse(init.body).text.format.name==='source_analysis')return modelResponse({...analysisOutput(sourceText),status:failure==='conflict'?'conflict':'ready'});
    return modelResponse({status:'reject',body:'',usedFactIds:[],numericClaims:[]});
  }));
  await expect(generateTweetDraft({...env,OPENAI_API_KEY:'fake-test-key'},item)).rejects.toThrow();
  expect(calls).toBe(failure==='reject'?2:1);
  expect(sql.prepare('SELECT COUNT(*) n FROM ai_tweet_drafts').get().n).toBe(0);
});
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
it('keeps GPT-6 Luna, separates source data, caches validated output and rejects truncation',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,body,url,tickers_json) VALUES ('news','Test','rss:ai','Vestel sözleşme','2 milyon avro','https://example.com/news','[\"VESTL\"]')");
  const item=sql.prepare('SELECT * FROM feed_items').get();
  let incomplete=false;
  const mock=vi.fn(async(url,init)=>{
    if(url===item.url) return new Response('<article>Vestel, 2 milyon avroluk sözleşme imzaladı.</article>',{headers:{'content-type':'text/html'}});
    const body=JSON.parse(init.body);expect(body.model).toBe('gpt-6-luna');expect(body.instructions).toContain('brüt/net');
    expect(JSON.parse(body.input[0].content[0].text).target.url).toBe(item.url);
    const fact={id:'f1',meaning:'Sözleşme tutarı',value:'2 milyon avro',metric:'cash_amount',scope:'unknown',unit:'avro',transactionDate:null,evidence:[{sourceId:'p1',quote:'2 milyon avroluk sözleşme',location:null}]};
    const output=body.text.format.name==='source_analysis'?analysisOutput('Vestel, 2 milyon avroluk sözleşme imzaladı.',[fact]):draftOutput('Vestel, 2 milyon avroluk sözleşme imzaladığını açıkladı.',['f1'],[{text:'2 milyon avroluk sözleşme',factId:'f1'}]);
    return modelResponse(output,incomplete?'incomplete':'completed');
  });
  vi.stubGlobal('fetch',mock);
  const result=await generateTweetDraft({...env,OPENAI_API_KEY:'test-fake'},item);
  expect(result.tweet).toBe('#VESTL\n\nVestel, 2 milyon avroluk sözleşme imzaladığını açıkladı.');
  expect((await generateTweetDraft({...env,OPENAI_API_KEY:'test-fake'},item)).cached).toBe(true);
  expect(mock).toHaveBeenCalledTimes(4);
  sql.exec('DELETE FROM ai_tweet_drafts');incomplete=true;
  await expect(generateTweetDraft({...env,OPENAI_API_KEY:'test-fake'},item)).rejects.toThrow('tamamlanmadı');
  expect(sql.prepare('SELECT count(*) AS n FROM ai_tweet_drafts').get().n).toBe(0);
});
it('regenerates ordinary drafts and sends extra instructions without overwriting the ordinary cache',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,body,url,tickers_json) VALUES ('news','Test','rss:custom','Sözleşme','Özet','https://example.com/custom','[]')");
  const item=sql.prepare("SELECT * FROM feed_items WHERE source_ref='rss:custom'").get();
  const instructions=[];
  const variants=['Şirket sözleşme imzaladı.','Şirket, sözleşmeye imza attı.','Şirket bir sözleşme imzaladığını açıkladı.'];
  let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url) return new Response('<article>Şirket sözleşme imzaladı.</article>',{headers:{'content-type':'text/html'}});
    const body=JSON.parse(init.body);
    if(body.text.format.name==='source_analysis')return modelResponse(analysisOutput('Şirket sözleşme imzaladı.'));
    instructions.push(body.instructions);calls++;
    return modelResponse(draftOutput(variants[calls-1]));
  }));
  const configured={...env,OPENAI_API_KEY:'test-fake'};
  expect((await generateTweetDraft(configured,item)).tweet).toContain(variants[0]);
  expect((await generateTweetDraft(configured,item)).cached).toBe(true);
  expect((await generateTweetDraft(configured,item,{regenerate:true})).tweet).toContain(variants[1]);
  expect((await generateTweetDraft(configured,item,{instruction:'Rakamı ilk cümlede vurgula.'})).tweet).toContain(variants[2]);
  expect(instructions[2]).toContain('KULLANICININ EK TALİMATI\nRakamı ilk cümlede vurgula.');
  expect(instructions[2]).toContain('Heran Borsa');
  expect((await generateTweetDraft(configured,item)).tweet).toContain(variants[1]);
  expect(calls).toBe(3);
});
it('invalidates cached drafts when source facts change and refuses unreadable evidence',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,body,url,tickers_json) VALUES ('news','Test','rss:updated','Kredi','Eski özet','https://example.com/updated','[]')");
  const item=sql.prepare("SELECT * FROM feed_items WHERE source_ref='rss:updated'").get();
  let html='<article>Şirket kredi limiti için başvurdu.</article>', calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response(html,{headers:{'content-type':'text/html'}});
    const body=JSON.parse(init.body), evidence=JSON.parse(body.input[0].content[0].text);
    expect(evidence.source.kind).toBe('article');expect(evidence.target.sourceRef).toBe(item.source_ref);
    expect(body.reasoning.effort).toBe(body.text.format.name==='source_analysis'?'high':'medium');
    if(body.text.format.name==='source_analysis')return modelResponse(analysisOutput(html.replace(/<[^>]+>/g,'')));
    calls++;
    return modelResponse(draftOutput(calls===1?'Şirket kredi limiti için başvurdu.':'Şirketin kredi limiti onaylandı.'));
  }));
  const configured={...env,OPENAI_API_KEY:'test-fake'};
  await generateTweetDraft(configured,item);
  html='<article>Şirketin kredi limiti onaylandı.</article>';
  expect((await generateTweetDraft(configured,item)).cached).toBe(false);expect(calls).toBe(2);
  html='<h1>Şirketin kredi limiti onaylandı.</h1>';
  await expect(generateTweetDraft(configured,item)).rejects.toThrow('ana metni');expect(calls).toBe(2);
});
it('maps PDF attachments to source references and does not reuse URL-only evidence caches',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('spk','SPK','spk:pdf','Bülten','https://example.com/bulten.pdf','[]')");
  const item=sql.prepare("SELECT * FROM feed_items WHERE source_ref='spk:pdf'").get();let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(url===item.url)return new Response('PDF',{headers:{'content-type':'application/pdf'}});
    calls++;const requestBody=JSON.parse(init.body),content=requestBody.input[0].content;
    const evidence=JSON.parse(content[0].text);
    expect(evidence.source.kind).toBe('pdf');expect(evidence.attachmentReferences[0].id).toBe('attachment-1');
    expect(JSON.parse(content[1].text).attachedSource).toBe('attachment-1');
    expect(content[2]).toEqual({type:'input_file',file_url:item.url,detail:'high'});
    return modelResponse(requestBody.text.format.name==='source_analysis'?analysisOutput('SPK başvuruyu onayladı.',[],'attachment-1'):draftOutput('SPK başvuruyu onayladı.'));
  }));
  const configured={...env,OPENAI_API_KEY:'test-fake'};
  await generateTweetDraft(configured,item);expect((await generateTweetDraft(configured,item)).cached).toBe(false);expect(calls).toBe(4);
});
