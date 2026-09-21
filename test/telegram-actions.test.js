import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {database} from './db-harness';
import {telegramRoutes,handleCallback} from '../src/telegram/webhook';
import {processAction,readerPages,splitText} from '../src/telegram/actions';
import {deliverOne,enqueueStatement} from '../src/telegram/outbox';
import {feedKeyboard} from '../src/telegram/buttons';
import {readerContent} from '../src/reader/content';
import {generateTweetDraft} from '../src/ai/tweet';
import {sendDocumentData} from '../src/telegram/client';
vi.mock('../src/reader/content',()=>({readerContent:vi.fn()}));
vi.mock('../src/ai/tweet',()=>({generateTweetDraft:vi.fn()}));
let sql,env,ctx,pending,item,wake;
const cb=(id='one',data='read:1')=>({callback_query:{id,data,from:{id:123},message:{message_id:70,chat:{id:123,type:'private'}}}});
const payload=()=>JSON.parse(sql.prepare('SELECT payload FROM telegram_outbox ORDER BY rowid DESC LIMIT 1').get().payload);
beforeEach(()=>{
  ({sql,env}=database());
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-20T20:00:00Z'));
  pending=[];ctx={waitUntil:p=>pending.push(p)};
  wake=vi.fn(async()=>new Response('OK'));
  env.TELEGRAM_ACTIONS={idFromName:n=>n,get:()=>({fetch:wake})};env.TELEGRAM_WEBHOOK_SECRET='test-secret';
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{message_id:100}}))));
  sql.prepare("INSERT INTO feed_items(id,type,source,source_ref,title,url) VALUES (1,'news','Test Kaynak','rss:test','Şirket <haber>','https://haberturk.com/test')").run();
  item=sql.prepare('SELECT * FROM feed_items WHERE id=1').get();
  vi.mocked(readerContent).mockReset().mockResolvedValue({status:'content',blocks:[{type:'paragraph',text:'Tam metin & açıklama.'}],attachments:[],notice:'Ek dosyalar dahil değildir.'});
  vi.mocked(generateTweetDraft).mockReset().mockResolvedValue({tweet:'#THYAO\n\nDoğal bir tweet.\n\n🔗 https://example.com',cached:false});
});
afterEach(async()=>{await Promise.all(pending);sql.close();vi.useRealTimers();vi.unstubAllGlobals();});

it('rejects missing/wrong webhook secrets before performing any action',async()=>{
  for(const secret of ['', 'wrong']) {
    const response=await telegramRoutes(new Request('https://worker/api/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':secret},body:JSON.stringify(cb())}),env,ctx);
    expect(response.status).toBe(401);
  }
  expect(wake).not.toHaveBeenCalled();expect(generateTweetDraft).not.toHaveBeenCalled();
});
it('accepts a signed callback but denies other chats/users and malformed button data',async()=>{
  for(const value of [ {...cb(),callback_query:{...cb().callback_query,from:{id:456}}}, {...cb(),callback_query:{...cb().callback_query,message:{message_id:70,chat:{id:456,type:'private'}}}}, cb('bad','read:https://evil.test') ]) await handleCallback(env,value,ctx);
  expect(sql.prepare('SELECT COUNT(*) n FROM telegram_actions').get().n).toBe(0);
  const response=await telegramRoutes(new Request('https://worker/api/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'test-secret'},body:JSON.stringify(cb())}),env,ctx);
  expect(response.status).toBe(200);expect(wake).toHaveBeenCalledTimes(1);
  expect(readerContent).not.toHaveBeenCalled(); // webhook returns quickly; durable worker does the work
});
it('deduplicates both Telegram redelivery and repeated presses, including completed replies',async()=>{
  await handleCallback(env,cb(),ctx);await handleCallback(env,cb(),ctx);await handleCallback(env,cb('two'),ctx);
  await processAction(env,'read');await handleCallback(env,cb('three'),ctx);await processAction(env,'read');
  expect(sql.prepare('SELECT COUNT(*) n FROM telegram_actions').get().n).toBe(1);
  expect(sql.prepare('SELECT COUNT(*) n FROM telegram_outbox').get().n).toBe(1);
  expect(readerContent).toHaveBeenCalledTimes(1);
  expect(payload()).toMatchObject({replyTo:70,plain:true});
  await deliverOne(env);
  const send=vi.mocked(fetch).mock.calls.find(([url])=>url.endsWith('/sendMessage'))[1].body;
  expect(send.get('text')).toContain('&lt;haber&gt;');expect(send.get('text')).toContain('&amp; açıklama');
  expect(JSON.parse(send.get('reply_parameters'))).toMatchObject({message_id:70});
});
it('sends one readable page at a time and continuation reuses stored text without fetching/AI',async()=>{
  vi.mocked(readerContent).mockResolvedValue({status:'content',blocks:[{type:'paragraph',text:'Uzun açıklama. '.repeat(800)}],attachments:[],notice:'Tam metin'});
  await handleCallback(env,cb(),ctx);await processAction(env,'read');
  const first=payload();expect(first.text.length).toBeLessThan(4096);
  const next=first.keyboard[0][0].callback_data;expect(next).toMatch(/^page:/);
  const continuation=cb('page',next);continuation.callback_query.message.message_id=100;
  await handleCallback(env,continuation,ctx);await processAction(env,'read');
  expect(payload().text).toContain('2/');expect(payload().replyTo).toBe(100);
  expect(readerContent).toHaveBeenCalledTimes(1);expect(generateTweetDraft).not.toHaveBeenCalled();
});
it('keeps tables, attachments and summary warnings, and never splits a surrogate pair',()=>{
  const pages=readerPages({status:'summary',notice:'Yalnız özet',blocks:[{type:'table',rows:[[{text:'Gelir'},{text:'100 TL'}]]}],attachments:[{filename:'Ek.pdf',url:'https://kap.org.tr/file.pdf'}]});
  expect(pages.join('')).toContain('Gelir | 100 TL');expect(pages.join('')).toContain('Yalnız özet');expect(pages.join('')).toContain('Ek.pdf');
  const chunks=splitText('a'.repeat(3199)+'💚'.repeat(2000));
  expect(chunks.join('')).toBe('a'.repeat(3199)+'💚'.repeat(2000));expect(chunks.every(p=>p.length<=3200)).toBe(true);
});
it('only invokes AI on tweet actions and delivers the draft without an extra prefix',async()=>{
  await handleCallback(env,cb('tweet','tweet:1'),ctx);
  await processAction(env,'read');expect(generateTweetDraft).not.toHaveBeenCalled();
  await processAction(env,'tweet');await processAction(env,'tweet');
  expect(generateTweetDraft).toHaveBeenCalledTimes(1);
  expect(payload().text).toBe('#THYAO\n\nDoğal bir tweet.\n\n🔗 https://example.com');
});
it('reports AI errors without automatically repeating a chargeable request',async()=>{
  vi.mocked(generateTweetDraft).mockRejectedValue(new Error('failure'));
  await handleCallback(env,cb('tweet','tweet:1'),ctx);await processAction(env,'tweet');await processAction(env,'tweet');
  expect(payload().text).toContain('Tweet oluşturulamadı');expect(generateTweetDraft).toHaveBeenCalledTimes(1);
  expect(sql.prepare('SELECT status FROM telegram_actions').get().status).toBe('failed');
});
it('recovers an expired processing lease with an explicit error, never repeating AI automatically',async()=>{
  await handleCallback(env,cb('tweet','tweet:1'),ctx);
  sql.prepare("UPDATE telegram_actions SET status='processing',lease_until=?").run(Date.now()-1);
  await processAction(env,'tweet');expect(payload().text).toContain('İşlem tamamlanamadı');expect(generateTweetDraft).not.toHaveBeenCalled();
});
it('waits for an in-progress reader cache and then completes once',async()=>{
  vi.mocked(readerContent).mockResolvedValueOnce(null);
  await handleCallback(env,cb(),ctx);expect(await processAction(env,'read')).toBe(2000);
  expect(sql.prepare('SELECT status FROM telegram_actions').get().status).toBe('queued');
  await processAction(env,'read');expect(sql.prepare('SELECT COUNT(*) n FROM telegram_outbox').get().n).toBe(1);
});
it('limits rapid distinct actions and leaves DKB messages unchanged',async()=>{
  for(let i=2;i<=8;i++) sql.prepare("INSERT INTO feed_items(id,type,source,source_ref,title,url) VALUES (?,'news','Source',?,'Title','https://haberturk.com/a')").run(i,`rss:${i}`);
  for(let i=1;i<=8;i++) await handleCallback(env,cb(`cb${i}`,`tweet:${i}`),ctx);
  expect(sql.prepare('SELECT COUNT(*) n FROM telegram_actions').get().n).toBe(6);
  expect(feedKeyboard({...item,type:'kap',title:'Pay Bazında Devre Kesici'})).toHaveLength(1);
});
it('adds buttons during news delivery but action replies are not suppressed by original delivery receipts',async()=>{
  await enqueueStatement(env,'rss:test','message',{text:'Title'},null).run();await deliverOne(env);
  const send=vi.mocked(fetch).mock.calls.find(([url])=>url.endsWith('/sendMessage'))[1].body;
  expect(JSON.parse(send.get('reply_markup')).inline_keyboard[1].map(b=>b.callback_data)).toEqual(['read:1','tweet:1']);
  await handleCallback(env,cb(),ctx);await processAction(env,'read');await deliverOne(env);
  expect(sql.prepare("SELECT status,source_ref FROM telegram_outbox WHERE kind='action_reply'").get()).toMatchObject({status:'sent',source_ref:null});
});
it('does not overwrite a different webhook during setup',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{url:'https://other.test/webhook',pending_update_count:0}}))));
  const response=await telegramRoutes(new Request('https://worker/api/telegram/setup',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'test-secret'}}),env,ctx);
  expect(response.status).toBe(409);expect(fetch).toHaveBeenCalledTimes(1);
});

it('queues /kurum and /terane templates once per Telegram message',async()=>{
  const send=async(messageId,text)=>{
    const response=await telegramRoutes(new Request('https://worker/api/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'test-secret'},body:JSON.stringify({message:{message_id:messageId,text,from:{id:123},chat:{id:123,type:'private'}}})}),env,ctx);
    expect(response.status).toBe(200);await Promise.all(pending.splice(0));
  };
  await send(201,'/kurum');await send(202,'/terane');await send(201,'/kurum');
  const jobs=sql.prepare('SELECT name,template_id,request_key FROM command_jobs ORDER BY created_at,id').all();
  expect(jobs).toHaveLength(2);
  expect(jobs.map(job=>job.name).sort()).toEqual(['Kurum','Terane']);
  expect(jobs.every(job=>job.request_key.startsWith('telegram:123:'))).toBe(true);
  expect(vi.mocked(fetch).mock.calls.filter(([url])=>url.endsWith('/sendMessage'))).toHaveLength(2);
});

it('uploads long combined text as a real Telegram document',async()=>{
  await sendDocumentData(env,'uzun kurum sonucu','kurum-tum-metinler.txt','Kurum · Tüm metinler','text/plain; charset=utf-8');
  const call=vi.mocked(fetch).mock.calls.find(([url])=>url.endsWith('/sendDocument'));
  expect(call).toBeTruthy();
  const file=call[1].body.get('document');
  expect(file).toBeInstanceOf(File);
  expect(file.name).toBe('kurum-tum-metinler.txt');
  expect(await file.text()).toBe('uzun kurum sonucu');
});
