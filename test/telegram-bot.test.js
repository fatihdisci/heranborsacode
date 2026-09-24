import {it,expect,vi,afterEach} from 'vitest';
import {database} from './db-harness';
import {telegramRoutes} from '../src/telegram/webhook';
afterEach(()=>vi.unstubAllGlobals());
it('accepts only the private owner and serves AI commands without finance commands',async()=>{
 const {env}=database();env.TELEGRAM_WEBHOOK_SECRET='webhook-test';env.PUBLIC_BASE_URL='https://example.com';
 const calls=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{calls.push(new URLSearchParams(init.body).get('text'));return new Response(JSON.stringify({ok:true,result:{message_id:1}}));}));
 const send=async(text,id=123)=>{const tasks=[];await telegramRoutes(new Request('https://example.com/api/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'webhook-test'},body:JSON.stringify({message:{message_id:1,text,from:{id},chat:{id:123,type:'private'}}})}),env,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);};
 await send('/start');await send('/son');await send('/resetler');await send('/durum');
 expect(calls).toHaveLength(4);expect(calls[0]).toContain('Vibe Radar');expect(calls[0]).toContain('otomatik gönderilmez');
 await send('/kurum');await send('/start',999);expect(calls).toHaveLength(4);
});
