// Real local Workerd/D1. Fixture credentials only; all network calls intercepted.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import * as runtime from 'miniflare';
const at=Date.parse('2026-09-30T17:30:00Z'),base='https://runtime.test',owner='fixture-owner';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'fixture',alg:'RS256',use:'sig'};
async function token(scope='command-results:read',overrides={}) {
 const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const input=enc({alg:'RS256',kid:'fixture'})+'.'+enc({iss:'https://issuer.test/',sub:owner,aud:base+'/api/command-results/mcp',scope,iat:at/1000,exp:at/1000+86400,...overrides});
 return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input))).toString('base64url');
}
const bundle=await build({write:false,bundle:true,format:'esm',platform:'browser',stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {resultsReaderRoutes} from ${JSON.stringify(resolve('src/commands/reader-routes.ts'))};
import {runEveningSummaries} from ${JSON.stringify(resolve('src/telegram/evening-summary.ts'))};
import {deliverOne} from ${JSON.stringify(resolve('src/telegram/outbox.ts'))};
let now=${at},sends=0,fail=false;Date.now=()=>now;
globalThis.fetch=async(url,init)=>{new Request(url,init);if(url==='https://issuer.test/jwks')return Response.json({keys:[${JSON.stringify(jwk)}]});if(url==='https://api.telegram.org/botfixture/sendMessage'){sends++;await new Promise(resolve=>setTimeout(resolve,50));if(fail)throw new Error('uncertain delivery');return Response.json({ok:true,result:{message_id:sends}});}throw new Error('Unexpected network call');};
export default{async fetch(req,env){const u=new URL(req.url);if(u.pathname==='/fixture/tick')return Response.json(await runEveningSummaries(env));if(u.pathname==='/fixture/send'){await deliverOne(env);return Response.json({sends});}if(u.pathname==='/fixture/time'){now=Number(u.searchParams.get('at'));fail=u.searchParams.get('fail')==='true';return Response.json({now});}return await resultsReaderRoutes(req,env)??new Response('not found',{status:404});}};`}});
const opts={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-20',d1Databases:{DB:'evening-fixture'},bindings:{EVENING_SUMMARY_ENABLED:'true',TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_CHAT_ID:'123',RESULTS_READ_ENABLED:'true',PUBLIC_BASE_URL:base,RESULTS_OAUTH_SUBJECT:owner,RESULTS_OAUTH_ISSUER:'https://issuer.test/',RESULTS_OAUTH_JWKS_URL:'https://issuer.test/jwks'}};
const mf=new runtime.Miniflare(typeof runtime.convertV4MiniflareOptions==='function'?runtime.convertV4MiniflareOptions(opts):opts);
try {
 const db=await mf.getD1Database('DB');
 for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())for(const statement of readFileSync('migrations/'+name,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 for(let offset=0;offset<550;offset+=50)await db.batch(Array.from({length:Math.min(50,550-offset)},(_,j)=>{const i=offset+j,code='A'+String(i).padStart(4,'0');return db.prepare('INSERT INTO kap_disclosures(disclosure_id,title,ticker,published_at,url,content_hash,metadata_json) VALUES (?,?,?,?,?,?,?)').bind(String(i),'Pay Bazında Devre Kesici Bildirimi',code,'2026-09-30T10:00:00Z','https://www.kap.org.tr/tr/Bildirim/'+i,'hash'+i,JSON.stringify({subjectCodes:[code]}));}));
 const signed=await token();
 async function rpc(method,params,bearer=signed){const r=await mf.dispatchFetch(base+'/api/command-results/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(bearer?{authorization:'Bearer '+bearer}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return{status:r.status,data:await r.json()};}
 const read=async(args={},bearer=signed)=>rpc('tools/call',{name:'get_evening_dkb_summary',arguments:{day:'2026-09-30',...args}},bearer);
 for(const bad of ['',await token('command-jobs:run'),await token(undefined,{sub:'wrong'}),await token(undefined,{aud:'wrong'})])assert.equal((await read({},bad)).status,401);
 const inventory=await rpc('tools/list',{});const tool=inventory.data.result.tools.find(t=>t.name==='get_evening_dkb_summary');assert.equal(tool.annotations.readOnlyHint,true);assert.deepEqual(tool.securitySchemes[0].scopes,['command-results:read']);
 assert.equal((await read()).data.result.structuredContent.status,'not_started');
 const tick=async()=>await(await mf.dispatchFetch(base+'/fixture/tick')).json();
 await Promise.all(Array.from({length:6},()=>tick()));
 const n=(await db.prepare("SELECT COUNT(*) n FROM telegram_outbox WHERE id LIKE 'day-summary:auto:%'").first()).n;assert.ok(n>1);assert.equal((await db.prepare("SELECT COUNT(*) n FROM telegram_outbox WHERE id LIKE '%:pay:%'").first()).n,0);
 const before=await read();assert.equal(before.data.result.structuredContent.shares.length,550);assert.equal(before.data.result.structuredContent.total_source_records,550);assert.equal(before.data.result.structuredContent.availability,'pending');
 let sources=[];for(let offset=0;offset!==null;){const s=(await read({source_offset:offset})).data.result.structuredContent;sources.push(...s.source_records);offset=s.next_source_offset;}assert.equal(new Set(sources.map(s=>s.disclosure_id)).size,550);
 const first=await Promise.all([mf.dispatchFetch(base+'/fixture/send'),mf.dispatchFetch(base+'/fixture/send')]);assert.equal(Math.max(...await Promise.all(first.map(r=>r.json()).map(async p=>(await p).sends))),1);
 for(let i=1;i<n;i++)await mf.dispatchFetch(base+'/fixture/send');await tick();const done=(await read()).data.result.structuredContent;assert.equal(done.status,'completed');assert.equal(done.all_pages_sent,true);assert.equal(done.full_text.includes('#A0549: 1'),true);assert.equal(done.total_shares,550);
 // A second day with uncertain send never retries or starts PAY.
 await mf.dispatchFetch(base+'/fixture/time?at='+ (at+86400000)+'&fail=true');await tick();await mf.dispatchFetch(base+'/fixture/send');assert.equal((await tick()).status,'needs_attention');const again=await(await mf.dispatchFetch(base+'/fixture/send')).json();assert.equal(again.sends,n+1);
 await mf.dispatchFetch(base+'/fixture/time?at='+Date.parse('2026-10-02T18:00:00Z'));assert.equal((await tick()).status,'outside_window');
 console.log('PASS Workerd/D1: OAuth read boundaries, inventory, six concurrent ticks, 550 stocks/sources pagination, ordered all-page delivery, no PAY, uncertain-send no replay, cutoff.');
} finally {await mf.dispose();}
