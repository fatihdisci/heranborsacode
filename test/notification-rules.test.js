import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {database} from './db-harness';
import {DEFAULTS,parsePreferences,decide,getPreferences,savePreferences,classify} from '../src/notifications/rules';
import {parseIndices,refreshIndices,getIndices,effectiveIndices} from '../src/notifications/indices';
import snapshot from '../src/notifications/index-snapshot.json';
import {enqueueStatement,deliverOne,flushDailyDigest,flushCircuitBreakers,nextDigestAt} from '../src/telegram/outbox';
import {listFeed} from '../src/db/feed';
import {api} from '../src/api/routes';
import {createHmac} from 'node:crypto';
let sql,env;
beforeEach(()=>{({sql,env}=database());vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));});
afterEach(()=>{sql.close();vi.useRealTimers();vi.unstubAllGlobals();});
const prefs=()=>structuredClone(DEFAULTS);
const item=(title='Yeni İş İlişkisi',codes=['THYAO'],body='Türk Hava Yolları')=>({id:1,type:'kap',source:'KAP',source_ref:'kap:1',title,body,tickers_json:JSON.stringify(codes),url:'https://www.kap.org.tr/tr/Bildirim/1',published_at:new Date().toISOString(),created_at:new Date().toISOString()});
const ok=()=>new Response(JSON.stringify({ok:true,result:{message_id:777}}));
async function queue(f,id='kap:1',kind='message'){
  sql.prepare('INSERT INTO feed_items(type,source,source_ref,title,body,url,tickers_json,published_at) VALUES (?,?,?,?,?,?,?,?)').run(f.type,f.source,id,f.title,f.body,f.url,f.tickers_json,f.published_at);
  await enqueueStatement(env,id,kind,kind==='dkb'?{codes:JSON.parse(f.tickers_json)}:{text:f.title},f.published_at).run();
}
function signedHeaders(){
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:123})});
  const key=createHmac('sha256','WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
  const text=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  params.set('hash',createHmac('sha256',key).update(text).digest('hex'));return {'x-telegram-init-data':params.toString(),'content-type':'application/json'};
}
it('applies exclusions, explicit watch rules, index priority and other-company topics in order',()=>{
  const p=prefs();p.otherCompanies='topics';p.watchlist=[{ticker:'THYAO',mode:'topics',topics:['dividend']}];
  expect(decide(item(),p,snapshot).action).toBe('off');
  expect(decide(item('Kar Payı Dağıtım İşlemlerine İlişkin Bildirim'),p,snapshot).action).toBe('instant');
  expect(decide(item('Kredi Kullanımı'),p,snapshot).action).toBe('off');
  expect(decide(item('Yeni İş İlişkisi',['ASELS']),p,snapshot)).toMatchObject({action:'instant',tier:30});
  expect(decide(item('Yeni İş İlişkisi',['ZZZZ']),p,snapshot).action).toBe('off');
  expect(decide(item('Payların Geri Alınmasına İlişkin Bildirim',['ZZZZ']),p,snapshot).action).toBe('instant');
  p.priorityIndices=false;expect(decide(item('Yeni İş İlişkisi',['ASELS']),p,snapshot).action).toBe('off');
});
it('never sends an İç Tüzük KAP notice even when all company alerts are enabled',async()=>{
  const p=prefs();p.excludedTitles=[];p.watchlist=[{ticker:'THYAO',mode:'all',topics:[]}];
  await savePreferences(env,p);
  for(const title of ['İç Tüzük','İçtüzük Değişikliği','FON İÇ TÜZÜĞÜ'])
    expect(decide(item(title),p,snapshot)).toMatchObject({action:'off',reason:'İç Tüzük bildirimi kapalı'});
  await queue(item('İç Tüzük'));
  const sent=vi.fn();vi.stubGlobal('fetch',sent);
  await deliverOne(env);
  expect(sent).not.toHaveBeenCalled();
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:1'").get().status).toBe('filtered');
  expect(sql.prepare('SELECT COUNT(*) n FROM feed_items').get().n).toBe(1);
});
it('distinguishes all versus important watched KAP and does not mistake fund investments for issuers',()=>{
  const p=prefs();p.watchlist=[{ticker:'THYAO',mode:'important',topics:[]}];p.funds='digest';
  expect(decide(item('Şirket Genel Bilgi Formu'),p,snapshot).action).toBe('off');p.watchlist[0].mode='all';expect(decide(item('Şirket Genel Bilgi Formu'),p,snapshot).action).toBe('instant');
  expect(decide(item('Fon birleşmesi',[],'AK PORTFÖY YÖNETİMİ'),p,snapshot).action).toBe('digest');
  expect(classify(item('Yeni İş İlişkisi',['THYAO'],'Fon yatırımı yapan şirket')).fund).toBe(false);
  expect(decide({...item('Kredi Kullanımı'),type:'news'},p,snapshot).action).toBe('instant');
});
it('validates rules and persists them per configured chat',async()=>{
  const p=prefs();p.watchlist=[{ticker:'THYAO',mode:'important',topics:[]}];await savePreferences(env,p);
  expect((await getPreferences(env)).watchlist).toEqual(p.watchlist);expect((await getPreferences({...env,TELEGRAM_CHAT_ID:'other'})).watchlist).toEqual([]);
  for(const invalid of [{...p,digestHour:24},{...p,otherTopics:['madeup']},{...p,watchlist:[...p.watchlist,...p.watchlist]},{...p,excludedTitles:['']},{...p,watchlist:[{ticker:'bad!',mode:'all',topics:[]}]}])expect(()=>parsePreferences(invalid)).toThrow();
});
it('uses exact validated official index membership and retains last good snapshot on bad refresh',async()=>{
  const html=JSON.stringify([{code:'XU030',content:snapshot.bist30.map(stockCode=>({stockCode}))},{code:'XU100',content:snapshot.bist100.map(stockCode=>({stockCode}))}]);
  expect(parseIndices(html).bist100).toHaveLength(100);expect(()=>parseIndices(html.replace('THYAO','INVALID'))).toThrow();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(html)));await refreshIndices(env);
  const good=await getIndices(env);vi.advanceTimersByTime(86400_001);vi.stubGlobal('fetch',vi.fn(async()=>new Response('challenge')));await refreshIndices(env);
  expect(await getIndices(env)).toEqual(good);
});
it('applies the published fourth-quarter index changes only when they take effect',()=>{
  const before=effectiveIndices(snapshot,Date.parse('2026-09-30T20:59:59Z'));
  const after=effectiveIndices(snapshot,Date.parse('2026-09-30T21:00:00Z'));
  expect(before).toEqual(snapshot);
  expect(after.bist30).toHaveLength(30);expect(after.bist100).toHaveLength(100);
  expect(after.bist30).toContain('TRMET');expect(after.bist30).not.toContain('DSTKF');
  expect(after.bist100).toContain('AGHOL');expect(after.bist100).not.toContain('BALSU');
  expect(after.bist30.every(code=>after.bist100.includes(code))).toBe(true);
  expect(effectiveIndices(after,Date.parse('2026-10-01T00:00:00Z'))).toEqual(after);
});
it('highlights BIST30 and applies changed rules before sending while preserving the feed',async()=>{
  const f=item();await queue(f);const sent=[];vi.stubGlobal('fetch',vi.fn(async(_,init)=>{sent.push(init.body.get('text'));return ok();}));
  const p=prefs();p.watchlist=[{ticker:'THYAO',mode:'important',topics:[]}];await savePreferences(env,p);await deliverOne(env);
  expect(sent[0]).toContain('⭐ BIST 30 · 🔔 Takip listem');
  await queue(item('Kredi Kullanımı'),'kap:2');await deliverOne(env);expect(sent).toHaveLength(1);
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:2'").get().status).toBe('filtered');expect(sql.prepare('SELECT count(*) n FROM feed_items').get().n).toBe(2);
});
it('holds funds until Istanbul summary time, retries one frozen summary and sends every receipt',async()=>{
  const p=prefs();p.funds='digest';await savePreferences(env,p);
  await queue(item('Fon birleşmesi',[],'Fon A'),'kap:1');await queue(item('Fon tasfiyesi',[],'Fon B'),'kap:2');
  const send=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:30}}),{status:429})).mockImplementation(ok);vi.stubGlobal('fetch',send);
  await deliverOne(env);await deliverOne(env);await flushDailyDigest(env);expect(send).not.toHaveBeenCalled();
  expect(nextDigestAt(Date.now(),19)).toBe(Date.parse('2026-09-28T16:00:00Z'));expect(nextDigestAt(Date.parse('2026-09-28T16:00:01Z'),19)).toBe(Date.parse('2026-09-29T16:00:00Z'));
  vi.setSystemTime(new Date('2026-09-28T16:00:01Z'));await flushDailyDigest(env);await flushDailyDigest(env);
  expect(sql.prepare("SELECT count(*) n FROM telegram_outbox WHERE kind='daily_digest'").get().n).toBe(1);
  await deliverOne(env);vi.advanceTimersByTime(30001);await deliverOne(env);
  expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0][1].body.get('text')).toContain('Fon birleşmesi');
  expect(sql.prepare("SELECT count(*) n FROM telegram_outbox WHERE status='sent' AND message_id=777").get().n).toBe(3);
});
it('applies fund opt-out to queued digest items without replaying them when re-enabled',async()=>{
  const p=prefs();p.funds='digest';await savePreferences(env,p);await queue(item('Fon birleşmesi',[],'Fon A'));await deliverOne(env);
  p.funds='off';await savePreferences(env,p);p.funds='instant';await savePreferences(env,p);
  expect(sql.prepare('SELECT status FROM telegram_outbox').get().status).toBe('filtered');
});
it('filters individual circuit breakers before grouping and keeps allowed stock codes',async()=>{
  const p=prefs();p.priorityIndices=false;p.otherCompanies='off';p.watchlist=[{ticker:'THYAO',mode:'all',topics:[]}];await savePreferences(env,p);
  await queue(item('Pay Bazında Devre Kesici Bildirimi',['THYAO']),'kap:1','dkb');await queue(item('Pay Bazında Devre Kesici Bildirimi',['ASELS']),'kap:2','dkb');vi.advanceTimersByTime(13000);await flushCircuitBreakers(env);
  const parent=sql.prepare("SELECT payload FROM telegram_outbox WHERE kind='dkb_group'").get();expect(parent.payload).toContain('#THYAO');expect(parent.payload).not.toContain('#ASELS');expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:2'").get().status).toBe('filtered');
});
it('keeps live DKB codes as text when KAP metadata contains JSON subject codes',async()=>{
  await queue(item('Pay Bazında Devre Kesici Bildirimi',['KUYAS'],'Devre kesici uygulandı.'),'kap:1','dkb');
  sql.prepare("INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,metadata_json) VALUES (?,?,?,?,?)")
    .run('1','Pay Bazında Devre Kesici Bildirimi','https://example.com/1','one',JSON.stringify({subjectCodes:['KUYAS']}));
  vi.advanceTimersByTime(13000);await flushCircuitBreakers(env);
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:1'").get().status).toBe('grouped');
  expect(sql.prepare("SELECT payload FROM telegram_outbox WHERE kind='dkb_group'").get().payload).toContain('#KUYAS');
});
it('filters by watchlist before pagination and protects settings API with signed Telegram auth',async()=>{
  for(let i=0;i<4;i++)await queue(item('Gelişme',[i%2?'THYAO':'ASELS']),'kap:'+i);
  const page=await listFeed(env,{limit:1,tickerList:['THYAO']});expect(page.items).toHaveLength(1);expect(JSON.parse(page.items[0].tickers_json)).toEqual(['THYAO']);expect(page.nextCursor).not.toBeNull();
  expect((await listFeed(env,{limit:10,tickerList:[]})).items).toEqual([]);
  const url='https://example.test/api/notification-preferences';expect((await api(new Request(url),env)).status).toBe(401);
  const p=prefs();p.watchlist=[{ticker:'THYAO',mode:'all',topics:[]}];const headers=signedHeaders();
  expect((await api(new Request(url,{method:'PUT',headers,body:JSON.stringify(p)}),env)).status).toBe(200);
  const saved=await (await api(new Request(url,{headers}),env)).json();expect(saved.preferences.watchlist[0].ticker).toBe('THYAO');
  const feed=await api(new Request('https://example.test/api/feed?scope=watchlist',{headers}),env);expect(feed.headers.get('cache-control')).toBe('no-store');const data=await feed.json();expect(data.items).toHaveLength(2);expect(data.items[0].notification).toMatchObject({watched:true,tier:30});
  expect((await api(new Request(url,{method:'PUT',headers,body:JSON.stringify({...p,digestHour:27})}),env)).status).toBe(400);
});
it('filters KAP by the disclosure subject, not unrelated shares listed on the same notice',async()=>{
  const insert=(id,codes,subjectCodes)=>{
    const ref=`kap:${id}`;
    sql.prepare('INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,metadata_json) VALUES (?,?,?,?,?)').run(String(id),'Dönemsel endeks değişikliği',`https://example.com/${id}`,String(id),subjectCodes===null?JSON.stringify({codes}):JSON.stringify({codes,subjectCodes}));
    sql.prepare('INSERT INTO feed_items(type,source,source_ref,title,body,url,tickers_json) VALUES (?,?,?,?,?,?,?)').run('kap','KAP',ref,'Dönemsel endeks değişikliği','BORSA İSTANBUL',`https://example.com/${id}`,JSON.stringify(codes));
  };
  insert(1,['ZZZZ','THYAO','ASELS'],null); // historical broad notice
  insert(2,['ZZZZ','THYAO'],['ZZZZ']); // related BIST 30 share, other issuer
  insert(3,['ZZZZ','THYAO'],['THYAO']); // real BIST 30 issuer
  const filtered=await listFeed(env,{limit:10,tickerList:snapshot.bist30});
  expect(filtered.items.map(x=>x.source_ref)).toEqual(['kap:3']);
  expect(decide(filtered.items[0],prefs(),snapshot).tier).toBe(30);
  const all=await listFeed(env,{limit:10});
  expect(all.items.find(x=>x.source_ref==='kap:1').notification).toBeUndefined();
  expect(decide(all.items.find(x=>x.source_ref==='kap:1'),prefs(),snapshot).tier).toBeNull();
  expect(decide(all.items.find(x=>x.source_ref==='kap:1'),prefs(),snapshot).action).toBe('instant');
  expect(decide(all.items.find(x=>x.source_ref==='kap:2'),prefs(),snapshot).tier).toBeNull();
});
it('rechecks excluded titles at digest assembly and rolls back a failed group write',async()=>{
  const p=prefs();p.funds='digest';await savePreferences(env,p);
  await queue(item('Fon birleşmesi',[],'Fon A'),'kap:1');await queue(item('Fon tasfiyesi',[],'Fon B'),'kap:2');await deliverOne(env);await deliverOne(env);
  p.excludedTitles.push('birleşmesi');await savePreferences(env,p);vi.setSystemTime(new Date('2026-09-28T16:00:01Z'));
  sql.exec("CREATE TRIGGER fail_digest BEFORE INSERT ON telegram_outbox WHEN NEW.kind='daily_digest' BEGIN SELECT RAISE(ABORT,'storage failure'); END");
  await expect(flushDailyDigest(env)).rejects.toThrow('storage failure');
  expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:1'").get().status).toBe('filtered');expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:2'").get().status).toBe('digest');
  sql.exec('DROP TRIGGER fail_digest');await flushDailyDigest(env);expect(sql.prepare("SELECT count(*) n FROM telegram_outbox WHERE kind='daily_digest'").get().n).toBe(1);
});
it('catches up an overdue fund summary after delivery downtime instead of delaying another day',async()=>{
  const p=prefs();p.funds='digest';await savePreferences(env,p);await queue(item('Fon birleşmesi',[],'Fon A'));
  vi.setSystemTime(new Date('2026-09-28T18:00:00Z'));await deliverOne(env);await flushDailyDigest(env);
  expect(sql.prepare("SELECT count(*) n FROM telegram_outbox WHERE kind='daily_digest'").get().n).toBe(1);
});
