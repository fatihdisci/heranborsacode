import {it,expect,vi,afterEach} from 'vitest';
import {database} from './db-harness';
import {cleanupLegacyMessages} from '../src/telegram/cleanup';

afterEach(()=>vi.unstubAllGlobals());
it('deletes only recorded legacy message IDs in bounded batches',async()=>{
 const {sql,env}=database();
 sql.prepare("INSERT INTO telegram_legacy_cleanup(message_id,sent_at) VALUES (1,datetime('now')), (2,datetime('now'))").run();
 const calls=[];
 vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
  expect(String(url)).toContain('/deleteMessages');
  calls.push(JSON.parse(new URLSearchParams(init.body).get('message_ids')));
  return new Response(JSON.stringify({ok:true,result:true}),{headers:{'content-type':'application/json'}});
 }));
 await cleanupLegacyMessages(env);
 expect(calls).toEqual([[1,2]]);
 expect(sql.prepare("SELECT COUNT(*) n FROM telegram_legacy_cleanup WHERE status='deleted'").get().n).toBe(2);
 expect(sql.prepare("SELECT value FROM system_state WHERE key='telegram_legacy_cleanup_done'").get()).toBeTruthy();
});
it('expires messages beyond the Bot API window without requesting deletion',async()=>{
 const {sql,env}=database();
 sql.prepare("INSERT INTO telegram_legacy_cleanup(message_id,sent_at) VALUES (3,datetime('now','-50 hours'))").run();
 const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 await cleanupLegacyMessages(env);
 expect(fetchMock).not.toHaveBeenCalled();
 expect(sql.prepare('SELECT status FROM telegram_legacy_cleanup WHERE message_id=3').get().status).toBe('expired');
});
