import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { database } from './db-harness';
import { enqueueStatement, flushCircuitBreakers, deliverOne } from '../src/telegram/outbox';
import { monitorOperations, shardProblem } from '../src/scheduler/monitor';
import { duplicateNews } from '../src/rss/dedupe';
import { formatDraft } from '../src/ai/prompt';

let sql,env;
beforeEach(()=>{({sql,env}=database());vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-20T20:00:00Z'));});
afterEach(()=>{sql.close();vi.useRealTimers();vi.unstubAllGlobals();});
const ok=()=>new Response(JSON.stringify({ok:true,result:{message_id:42}}));
describe('persistent delivery',()=>{
  it('flushes a DKB window while intake continues and never marks later arrivals sent',async()=>{
    await enqueueStatement(env,'kap:1','dkb',{codes:['THYAO']},null).run();
    vi.advanceTimersByTime(8000);
    await enqueueStatement(env,'kap:2','dkb',{codes:['ASELS','THYAO']},null).run();
    await flushCircuitBreakers(env);
    expect(sql.prepare("SELECT count(*) AS n FROM telegram_outbox WHERE status='pending'").get().n).toBe(0);
    vi.advanceTimersByTime(5000);
    await enqueueStatement(env,'kap:3','dkb',{codes:['VESTL']},null).run();
    await flushCircuitBreakers(env);
    const fetchMock=vi.fn(async(_url,init)=>{expect(init.body.get('text')).toBe('#THYAO #ASELS\n\nDevre kesici uygulandı. Sürekli işleme ara verildi.');return ok();});
    vi.stubGlobal('fetch',fetchMock);
    await deliverOne(env);
    expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:3'").get().status).toBe('buffered');
    expect(sql.prepare("SELECT message_id,status FROM telegram_outbox WHERE id='kap:1'").get()).toMatchObject({message_id:42,status:'sent'});
    await flushCircuitBreakers(env);await deliverOne(env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('honors Telegram retry_after globally, survives retries and records API acceptance',async()=>{
    await enqueueStatement(env,'rss:1','message',{text:'Test'},null).run();
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:40}}),{status:429})).mockImplementation(ok);
    vi.stubGlobal('fetch',fetchMock);
    expect(await deliverOne(env)).toBe(40000);
    await deliverOne(env);expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40001);
    await deliverOne({...env});
    expect(sql.prepare("SELECT status,attempts,message_id,sent_at FROM telegram_outbox WHERE id='rss:1'").get()).toMatchObject({status:'sent',attempts:2,message_id:42,sent_at:'2026-09-20T20:00:40.001Z'});
  });
  it('keeps permanent errors visible and lets other messages progress',async()=>{
    await enqueueStatement(env,'rss:1','message',{text:'Bad'},null).run();
    await enqueueStatement(env,'rss:2','message',{text:'Good'},null).run();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error_code:400}),{status:400})).mockImplementation(ok));
    await deliverOne(env);await deliverOne(env);
    expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='rss:1'").get().status).toBe('blocked');
    expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='rss:2'").get().status).toBe('sent');
  });
  it('claims jobs atomically so concurrent invocations cannot send the same job',async()=>{
    await enqueueStatement(env,'rss:1','message',{text:'Only once'},null).run();
    const fetchMock=vi.fn(ok);vi.stubGlobal('fetch',fetchMock);
    await Promise.all([deliverOne(env),deliverOne(env)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
describe('operational signals',()=>{
  it('opens one incident, remains quiet, sends one recovery',async()=>{
    const state={startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),nextScheduledAt:new Date(Date.now()+60000).toISOString(),failures:3,error:'HTTP 503'};
    sql.prepare("INSERT INTO system_state(key,value) VALUES ('poll_shard:rss:0',?)").run(JSON.stringify(state));
    await monitorOperations(env);await monitorOperations(env);
    expect(sql.prepare("SELECT count(*) AS n FROM telegram_outbox WHERE id LIKE 'alert:%'").get().n).toBe(1);
    sql.prepare("UPDATE system_state SET value=? WHERE key='poll_shard:rss:0'").run(JSON.stringify({...state,failures:0,error:null}));
    await monitorOperations(env);await monitorOperations(env);
    expect(sql.prepare("SELECT count(*) AS n FROM telegram_outbox WHERE id LIKE 'recovery:%'").get().n).toBe(1);
  });
  it('does not confuse no news or a long SPK interval with failure',()=>{
    expect(shardProblem({finishedAt:'2026-09-20T12:00:00Z',nextScheduledAt:'2026-09-20T22:00:00Z',failures:0,error:null},Date.now())).toBeNull();
  });
});
describe('editorial correctness',()=>{
  it('keeps updated amounts, opposite decisions and body-only updates',()=>{
    expect(duplicateNews({title:'Şirket 10 milyon TL geri alım yaptı',summary:''},{title:'Şirket 20 milyon TL geri alım yaptı',summary:''})).toBe(false);
    expect(duplicateNews({title:'Fon ödemesi onaylandı',summary:''},{title:'Fon ödemesi onaylanmadı',summary:''})).toBe(false);
    expect(duplicateNews({title:'Fon açıklaması',summary:'Ödeme bekleniyor'},{title:'Fon açıklaması',summary:'Ödeme tamamlandı'})).toBe(false);
    expect(duplicateNews({title:'Fon açıklaması.',summary:'Ödeme tamamlandı'},{title:'Fon açıklaması',summary:'Ödeme tamamlandı'})).toBe(true);
  });
  it('attaches only validated symbols and exact source URL, preserving paragraphs',()=>{
    expect(formatDraft('Yeni sözleşme imzalandı.\n\nTeslimatlar gelecek yıl yapılacak.',['THYAO','SKP','THYAO'],'https://example.com/article')).toBe('#THYAO\n\nYeni sözleşme imzalandı.\n\nTeslimatlar gelecek yıl yapılacak.\n\n🔗 https://example.com/article');
    expect(()=>formatDraft('INSUFFICIENT_SOURCE',[],'https://example.com')).toThrow();
    expect(()=>formatDraft('Uydurulan #SKP',[],'https://example.com')).toThrow();
  });
});
