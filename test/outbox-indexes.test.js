import {it,expect,vi} from 'vitest';
import {database} from './db-harness';
import {enqueueStatement,deliverOne,flushCircuitBreakers} from '../src/telegram/outbox';
it('prioritizes a ready DKB batch and updates exact original source IDs',async()=>{
  const {sql,env}=database();
  try {
    await enqueueStatement(env,'rss:old','message',{text:'Older news'},null,new Date(Date.now()-30000).toISOString()).run();
    sql.prepare("INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,telegram_status) VALUES ('1','DKB','https://example.com','1','pending')").run();
    await enqueueStatement(env,'kap:1','dkb',{codes:['THYAO']},null,new Date(Date.now()-13000).toISOString()).run();
    await flushCircuitBreakers(env);
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{expect(init.body.get('text')).toContain('#THYAO');return new Response(JSON.stringify({ok:true,result:{message_id:77}}));}));
    await deliverOne(env);
    expect(sql.prepare("SELECT telegram_status FROM kap_disclosures WHERE disclosure_id='1'").get().telegram_status).toBe('sent');
    expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='rss:old'").get().status).toBe('pending');
  } finally {sql.close();vi.unstubAllGlobals();}
});
it('does not replay a legacy delivery accepted during the rollout',async()=>{
  const {sql,env}=database();
  try {
    sql.prepare("INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,telegram_status) VALUES ('1','KAP','https://example.com','1','sent')").run();
    await enqueueStatement(env,'kap:1','message',{text:'Previously sent'},null).run();
    const mock=vi.fn();vi.stubGlobal('fetch',mock);await deliverOne(env);
    expect(mock).not.toHaveBeenCalled();
    expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:1'").get().status).toBe('superseded');
  } finally {sql.close();vi.unstubAllGlobals();}
});
