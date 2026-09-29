import { afterEach, expect, it, vi } from 'vitest';
import { database } from './db-harness';
import { listFeed } from '../src/db/feed';
import { deliverOne, enqueueStatement, flushCircuitBreakers } from '../src/telegram/outbox';
import { ensureTelegramWebhook } from '../src/telegram/webhook';

const opened=[];
afterEach(()=>{for(const sql of opened) sql.close();opened.length=0;vi.unstubAllGlobals();});
function setup() { const value=database();opened.push(value.sql);return value; }

it('shows historical finance records while retaining AI rows outside the feed',async()=>{
  const {sql,env}=setup();
  sql.prepare("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('news','Foreks','rss:finance','BIST haberi','https://example.com/finance','[]')").run();
  sql.prepare("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json,category) VALUES ('news','OpenAI','ai:news','AI haberi','https://example.com/ai','[]','openai')").run();
  expect((await listFeed(env,{limit:30})).items.map(item=>item.title)).toEqual(['BIST haberi']);
});

it('leaves AI-era pending deliveries untouched and sends the next finance item',async()=>{
  const {sql,env}=setup();
  await enqueueStatement(env,'ai:news','message',{text:'AI haberi'},null).run();
  await enqueueStatement(env,'rss:finance','message',{text:'BIST haberi'},null).run();
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{message_id:42}})));
  vi.stubGlobal('fetch',fetchMock);
  await deliverOne(env);
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='ai:news'").get().status).toBe('pending');
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='rss:finance'").get().status).toBe('sent');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('reconfigures the existing Telegram bot when the stored version is Vibe Radar',async()=>{
  const {sql,env}=setup();
  env.TELEGRAM_WEBHOOK_SECRET='fake-secret';
  sql.prepare("INSERT INTO system_state(key,value) VALUES ('telegram_webhook_version','vibe-radar-v1')").run();
  const calls=[];
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    calls.push({method:String(url).split('/').at(-1),body:init.body});
    return new Response(JSON.stringify({ok:true,result:true}));
  }));
  await ensureTelegramWebhook(env);
  expect(calls.map(call=>call.method)).toEqual(['setWebhook','setChatMenuButton','setMyCommands']);
  expect(JSON.parse(calls[1].body.get('menu_button')).text).toBe('Heran Borsa');
  const commands=JSON.parse(calls[2].body.get('commands')).map(command=>command.command);
  expect(commands).toContain('terane');
  expect(commands).toContain('akdterane');
  expect(commands).not.toContain('resetler');
  expect(sql.prepare("SELECT value FROM system_state WHERE key='telegram_webhook_version'").get().value).toBe('heranborsa-restore-v2');
  await ensureTelegramWebhook(env);
  expect(calls).toHaveLength(3);
});

it('delivers only finance items published since the requested cutoff',async()=>{
  const {sql,env}=setup();
  sql.prepare("INSERT INTO system_state(key,value) VALUES ('finance_notification_cutoff_at','2026-09-28T03:50:27.000Z')").run();
  await enqueueStatement(env,'kap:old','message',{text:'Old KAP'},'2026-09-24T14:56:27.000Z').run();
  await enqueueStatement(env,'rss:old','message',{text:'Old RSS'},'2026-09-28T03:50:26.000Z').run();
  await enqueueStatement(env,'kap:new','message',{text:'New KAP'},'2026-09-28T03:50:28.000Z').run();
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{message_id:42}})));
  vi.stubGlobal('fetch',fetchMock);
  await deliverOne(env);
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:new'").get().status).toBe('sent');
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:old'").get().status).toBe('pending');
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='rss:old'").get().status).toBe('pending');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('never folds a pre-cutoff KAP breaker into a new breaker message',async()=>{
  const {sql,env}=setup();
  sql.prepare("INSERT INTO system_state(key,value) VALUES ('finance_notification_cutoff_at','2026-09-28T03:50:27.000Z')").run();
  const seen=new Date(Date.now()-30_000).toISOString();
  await enqueueStatement(env,'kap:old','dkb',{codes:['OLDCO']},'2026-09-24T14:56:27.000Z',seen).run();
  await enqueueStatement(env,'kap:new','dkb',{codes:['THYAO']},'2026-09-28T03:50:28.000Z',seen).run();
  await flushCircuitBreakers(env);
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:old'").get().status).toBe('buffered');
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:new'").get().status).toBe('grouped');
  const group=sql.prepare("SELECT payload FROM telegram_outbox WHERE kind='dkb_group'").get();
  expect(JSON.parse(group.payload).text).toContain('#THYAO');
  expect(JSON.parse(group.payload).text).not.toContain('OLDCO');
});
