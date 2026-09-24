import {it,expect,vi,afterEach} from 'vitest';
import {database} from './db-harness';
import {enqueueStatement,deliverOne} from '../src/telegram/outbox';
afterEach(()=>vi.unstubAllGlobals());
it('keeps one outbox row for a duplicate AI event and records Telegram acceptance',async()=>{
 const {sql,env}=database();
 await enqueueStatement(env,'ai:one','message',{text:'🤖 New Codex model'},null).run();
 await enqueueStatement(env,'ai:one','message',{text:'duplicate'},null).run();
 expect(sql.prepare('SELECT count(*) n FROM telegram_outbox').get().n).toBe(1);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{message_id:77}}))));
 await deliverOne(env);
 expect(sql.prepare("SELECT status,message_id FROM telegram_outbox WHERE id='ai:one'").get()).toMatchObject({status:'sent',message_id:77});
});
it('applies Telegram 429 retry_after without losing the queued AI item',async()=>{
 const {sql,env}=database();await enqueueStatement(env,'ai:two','message',{text:'New model'},null).run();
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:12}}),{status:429})));
 await deliverOne(env);
 expect(sql.prepare("SELECT status,attempts FROM telegram_outbox WHERE id='ai:two'").get()).toMatchObject({status:'pending',attempts:1});
 expect(Number(sql.prepare("SELECT value FROM system_state WHERE key='telegram_cooldown_until'").get().value)).toBeGreaterThan(Date.now());
});
it('supersedes pending finance delivery from the old runtime',async()=>{
 const {sql,env}=database();await enqueueStatement(env,'kap:old','message',{text:'Old finance'},null).run();
 const mock=vi.fn();vi.stubGlobal('fetch',mock);await deliverOne(env);
 expect(mock).not.toHaveBeenCalled();expect(sql.prepare("SELECT status FROM telegram_outbox WHERE id='kap:old'").get().status).toBe('superseded');
});
