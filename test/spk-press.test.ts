import {afterEach,beforeEach,expect,it,vi} from 'vitest';
// @ts-ignore The in-memory D1 fixture is a JavaScript test helper.
import {database} from './db-harness';
import {parsePressBody,parsePressList,pollSPKPress,isFundPress} from '../src/spk/press';
import {extractArticleSource} from '../src/ai/source-extract';
import {feedKeyboard} from '../src/telegram/buttons';
import {deliverOne,enqueueStatement} from '../src/telegram/outbox';
import {listFeed} from '../src/db/feed';

let sql:ReturnType<typeof database>['sql'];
let env:ReturnType<typeof database>['env'];
const old='/duyurular/basin-duyurulari/2026/onceki-fon-duyurusu';
const fresh='/duyurular/basin-duyurulari/2026/yeni-fon-duyurusu';
const list=(newEntry:boolean)=>`<main><div class="liste">${newEntry?`<a class="link" href="${fresh}"><div class="liste-tarih">29 Eyl 2026</div><div class="liste-baslik">Fon Tasfiyesinde Yeni Karar</div></a>`:''}<a class="link" href="${old}"><div class="liste-tarih">28 Eyl 2026</div><div class="liste-baslik">Önceki Fon Duyurusu</div></a></div></main>`;
const article=`<div class="page-content print-container"><h3 class="baslik">Fon Tasfiyesinde Yeni Karar</h3><div class="icerik styled-content"><p>Tasfiyeye konu yatırım fonlarının katılma payı sahiplerine ödeme yapılmasına ilişkin yeni karar açıklandı.</p><p>Duyuruyu PDF formatında indirmek için tıklayınız.</p></div></div>`;

beforeEach(()=>{({sql,env}=database());vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-29T13:00:00Z'));});
afterEach(()=>{sql.close();vi.useRealTimers();vi.unstubAllGlobals();});

it('parses only official dated press cards and the announcement body',()=>{
  expect(parsePressList(list(true),2026)[0]).toMatchObject({title:'Fon Tasfiyesinde Yeni Karar',url:`https://spk.gov.tr${fresh}`,publishedAt:'2026-09-28T21:00:00.000Z'});
  expect(parsePressBody(article)).toContain('katılma payı sahiplerine ödeme');
  expect(parsePressBody(article)).not.toContain('PDF formatında');
  expect(isFundPress('Basın Duyurusu',parsePressBody(article))).toBe(true);
  expect(isFundPress('Personel sınavı','Başvurular başladı.')).toBe(false);
  expect(extractArticleSource(article,{type:'spk',url:`https://spk.gov.tr${fresh}`,title:'Fon Tasfiyesinde Yeni Karar'}).text).toContain('katılma payı sahiplerine ödeme');
});

it('silently baselines the current page, then sends only a new fund release once',async()=>{
  let hasNew=false;
  const fetchMock=vi.fn(async (url:string)=>new Response(url.endsWith('/2026')?list(hasNew):article,{headers:{'content-type':'text/html'}}));
  vi.stubGlobal('fetch',fetchMock);
  sql.prepare("INSERT INTO system_state(key,value) VALUES ('finance_notification_cutoff_at','2026-09-29T09:00:00.000Z')").run();
  await pollSPKPress(env);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(0);
  hasNew=true;
  await pollSPKPress(env);
  const q=sql.prepare('SELECT id,kind,status,payload FROM telegram_outbox').get();
  expect(q.id).toBe('spk:press:2026:yeni-fon-duyurusu');
  expect(q.kind).toBe('priority_message');
  expect(q.status).toBe('pending');
  expect(JSON.parse(q.payload).text).toContain('Resmî açıklama');
  const item=sql.prepare('SELECT * FROM feed_items').get();
  expect(item.body).toContain('katılma payı sahiplerine ödeme');
  expect(feedKeyboard(item)).toHaveLength(2);
  await pollSPKPress(env);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it('delivers an official fund alert ahead of routine backlog with source and draft actions',async()=>{
  env.TELEGRAM_WEBHOOK_SECRET='fake-webhook-secret';
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(url.endsWith('/2026')?list(false):article,{headers:{'content-type':'text/html'}})));
  await pollSPKPress(env);
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(url.endsWith('/2026')?list(true):article,{headers:{'content-type':'text/html'}})));
  await enqueueStatement(env,'rss:routine','message',{text:'Rutin haber'},new Date().toISOString(),'2026-09-29T12:00:00.000Z').run();
  await pollSPKPress(env);
  const sent=vi.fn(async(_url:string,_request:RequestInit)=>new Response(JSON.stringify({ok:true,result:{message_id:42}})));
  vi.stubGlobal('fetch',sent);
  await deliverOne(env);
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='spk:press:2026:yeni-fon-duyurusu'").get().status).toBe('sent');
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='rss:routine'").get().status).toBe('pending');
  const request=sent.mock.calls[0][1] as RequestInit;
  const keyboard=JSON.parse((request.body as URLSearchParams).get('reply_markup')!);
  expect(keyboard.inline_keyboard.flat().map((button:{text:string})=>button.text)).toContain('✦ Tweet oluştur');
});

it('places a date-only SPK release at first sight and paginates after it',async()=>{
  sql.prepare("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json,published_at,created_at) VALUES ('news','Test','rss:late','Haber','https://example.com/news','[]','2026-09-29T11:00:00.000Z','2026-09-29 11:00:00')").run();
  sql.prepare("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json,published_at,created_at) VALUES ('spk','SPK','spk:press:2026:new','Duyuru','https://spk.gov.tr/new','[]','2026-09-28T21:00:00.000Z','2026-09-29 12:00:00')").run();
  const first=await listFeed(env,{limit:1});
  expect(first.items[0].title).toBe('Duyuru');
  const [time,id]=first.nextCursor!.split('|');
  const second=await listFeed(env,{limit:1,cursor:{time,id:Number(id)}});
  expect(second.items[0].title).toBe('Haber');
});
