// Standalone test: real Workerd + local D1, no live services, accounts or tokens.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import * as miniflareRuntime from 'miniflare';
const { Miniflare, convertV4MiniflareOptions } = miniflareRuntime;

const pair = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'runtime-fixture',alg:'RS256',use:'sig'};
const owner='runtime-owner',base='https://runtime.test',scope='command-results:read command-jobs:run';
async function token(s=scope,overrides={}){
  const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000);
  const input=b64({alg:'RS256',kid:jwk.kid})+'.'+b64({iss:'https://runtime-issuer.test/',sub:owner,aud:base+'/api/command-results/mcp',scope:s,iat:now,exp:now+900,...overrides});
  return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input))).toString('base64url');
}
const bundle=await build({write:false,bundle:true,format:'esm',platform:'browser',stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {resultsReaderRoutes} from ${JSON.stringify(resolve('src/commands/reader-routes.ts'))};
import {claimCommandJob,refreshActiveWorkflow} from ${JSON.stringify(resolve('src/commands/workflows.ts'))};
import {previewCommandMediaRetention,runCommandMediaRetention} from ${JSON.stringify(resolve('src/commands/media-retention.ts'))};
import {getReaderJob,getReaderMedia} from ${JSON.stringify(resolve('src/commands/reader.ts'))};
const fixtureKey=${JSON.stringify(jwk)};
globalThis.fetch=async(url,init)=>{
  if(url!=='https://runtime-issuer.test/jwks')throw new Error('Unexpected external request');
  // Actual Workerd validates RequestInit, including redirect compatibility.
  new Request(url,init);
  if(init.redirect!=='manual')throw new Error('JWKS must never follow redirects');
  return Response.json({keys:[fixtureKey]});
};
export default {async fetch(request,env){
  const p=new URL(request.url).pathname;
  if(p==='/fixture/retention-preview')return Response.json(await previewCommandMediaRetention(env,Date.parse('2026-09-30T09:00:00Z')));
  if(p==='/fixture/retention-delete')return Response.json(await runCommandMediaRetention(env,Date.parse('2026-09-30T09:00:00Z')));
  if(p==='/fixture/retention-read')return Response.json(await getReaderJob(env,'00000000-0000-4000-8000-000000000001'));
  if(p==='/fixture/retention-media') {try {await getReaderMedia(env,'00000000-0000-4000-8000-000000000001',Number(new URL(request.url).searchParams.get('id')));return new Response('unexpected');}catch(e){return Response.json({code:e.code},{status:e.status});}}
  if(p==='/fixture/claim')return Response.json(await claimCommandJob(env,crypto.randomUUID(),new Date(Date.now()+600000).toISOString().replace('T',' ').slice(0,19)));
  if(p==='/fixture/refresh')return Response.json(await refreshActiveWorkflow(env));
  return await resultsReaderRoutes(request,env)??new Response('Not found',{status:404});
}};`}});
const opts={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-20',d1Databases:{DB:'runtime-fixture-db'},r2Buckets:{COMMAND_MEDIA:'runtime-media'},
  bindings:{COMMAND_MEDIA_RETENTION_MODE:'delete',COMMAND_RUN_ENABLED:'true',RESULTS_READ_ENABLED:'true',RESULTS_OAUTH_SUBJECT:owner,PUBLIC_BASE_URL:base,
    RESULTS_OAUTH_ISSUER:'https://runtime-issuer.test/',RESULTS_OAUTH_JWKS_URL:'https://runtime-issuer.test/jwks'}};
const mf=new Miniflare(typeof convertV4MiniflareOptions==='function'?convertV4MiniflareOptions(opts):opts);
try{
  const db=await mf.getD1Database('DB');
  // Execute actual repository migration statements, including workflow lock index.
  for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort()){
    const raw=readFileSync('migrations/'+name,'utf8').replace(/--[^\n]*/g,'');
    for(const statement of raw.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  }
  const signed=await token(),at=new Date().toISOString(),args={mode:'market_round',request_key:'runtime-test-market-round',requested_at:at};
  const call=async(name,arguments_,bearer=signed)=>{
    const r=await mf.dispatchFetch(base+'/api/command-results/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+bearer},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}})});
    return {status:r.status,data:await r.json()};
  };
  assert.equal((await call('start_command_workflow',args,await token('command-results:read'))).status,401);
  assert.equal((await call('start_command_workflow',args,await token(scope,{sub:'wrong-owner'}))).status,401);
  assert.equal((await call('start_command_workflow',args,await token(scope,{aud:'wrong-resource'}))).status,401);
  const concurrent=await Promise.all(Array.from({length:6},()=>call('start_command_workflow',args)));
  for(const r of concurrent){assert.equal(r.status,200);assert.equal(r.data.result.isError,false);}
  const run=concurrent[0].data.result.structuredContent;
  assert.equal(new Set(concurrent.map(r=>r.data.result.structuredContent.workflow_id)).size,1);
  assert.equal(concurrent.filter(r=>r.data.result.structuredContent.created).length,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM command_jobs').first()).n,1);
  assert.equal(run.jobs[0].template,'terane');assert.equal(run.jobs[1].status,'not_started');
  const claims=await Promise.all(Array.from({length:4},async()=>await(await mf.dispatchFetch(base+'/fixture/claim')).json()));
  assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean).id,run.current_job_id);
  const first=await db.prepare('SELECT steps_json FROM command_jobs WHERE id=?').bind(run.current_job_id).first();
  const steps=JSON.parse(first.steps_json);
  await db.batch(steps.map((s,i)=>db.prepare('INSERT INTO command_results(job_id,step_index,bot_username,command,response_text) VALUES (?,?,?,?,?)').bind(run.current_job_id,i,s.botUsername,s.command,'Runtime fixture')));
  await db.prepare("UPDATE command_jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL,finished_at=CURRENT_TIMESTAMP WHERE id=?").bind(run.current_job_id).run();
  await Promise.all(Array.from({length:4},()=>mf.dispatchFetch(base+'/fixture/refresh')));
  const progress=(await call('get_command_workflow',{workflow_id:run.workflow_id},await token('command-results:read'))).data.result.structuredContent;
  assert.equal(progress.current_index,1);assert.equal(progress.jobs[1].template,'kurum');assert.notEqual(progress.current_job_id,run.current_job_id);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM command_jobs').first()).n,2);
  assert.equal(progress.source_data_at,null);
  await db.prepare("UPDATE command_jobs SET status='failed',finished_at=CURRENT_TIMESTAMP WHERE id=?").bind(progress.current_job_id).run();
  await mf.dispatchFetch(base+'/fixture/refresh');
  const retry=(await call('start_command_workflow',args)).data.result.structuredContent;
  assert.equal(retry.created,false);assert.equal(retry.status,'failed');assert.equal((await db.prepare('SELECT COUNT(*) n FROM command_jobs').first()).n,2);
  const general=(await call('start_command_workflow',{mode:'genelkurum',request_key:'runtime-genel-kurum-one-time',requested_at:new Date().toISOString()})).data.result.structuredContent;
  assert.equal(general.mode,'genelkurum');assert.equal(general.jobs.length,1);assert.equal(general.jobs[0].template,'genelkurum');assert.equal(general.jobs[0].expected_steps,1);
  const generalJob=await db.prepare('SELECT steps_json FROM command_jobs WHERE id=?').bind(general.current_job_id).first();
  assert.deepEqual(JSON.parse(generalJob.steps_json),[{botUsername:'ucretsizderinlikbot',command:'/kurum',delaySeconds:3}]);
  assert.equal((await(await mf.dispatchFetch(base+'/fixture/claim')).json()).id,general.current_job_id);
  await db.prepare("INSERT INTO command_results(job_id,step_index,bot_username,command,response_text,response_kind) VALUES (?,0,'ucretsizderinlikbot','/kurum','Plain institution summary fixture','text')").bind(general.current_job_id).run();
  await db.prepare("UPDATE command_jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL,finished_at=CURRENT_TIMESTAMP WHERE id=?").bind(general.current_job_id).run();
  await mf.dispatchFetch(base+'/fixture/refresh');
  assert.equal((await call('get_command_workflow',{workflow_id:general.workflow_id})).data.result.structuredContent.status,'completed');
  const generalText=(await call('get_command_result_job',{job_id:general.current_job_id})).data.result.structuredContent;
  assert.equal(generalText.result_set_complete,true);assert.ok(generalText.full_text.includes('Plain institution summary fixture'));assert.equal(generalText.results[0].media_state,'none');
  const queued=(await call('start_command_workflow',{mode:'kurum',request_key:'runtime-agent-offline-timeout',requested_at:new Date().toISOString()})).data.result.structuredContent;
  await db.prepare("UPDATE command_workflows SET start_before='2000-01-01 00:00:00' WHERE id=?").bind(queued.workflow_id).run();
  assert.equal(await(await mf.dispatchFetch(base+'/fixture/claim')).json(),null);
  assert.equal((await call('get_command_workflow',{workflow_id:queued.workflow_id})).data.result.structuredContent.status,'timed_out');
  assert.equal((await db.prepare('SELECT status FROM command_jobs WHERE id=?').bind(queued.current_job_id).first()).status,'cancelled');
  const uncertain=(await call('start_command_workflow',{mode:'terane',request_key:'runtime-agent-expired-lease',requested_at:new Date().toISOString()})).data.result.structuredContent;
  assert.equal((await(await mf.dispatchFetch(base+'/fixture/claim')).json()).id,uncertain.current_job_id);
  await db.prepare("UPDATE command_jobs SET lease_expires_at='2000-01-01 00:00:00' WHERE id=?").bind(uncertain.current_job_id).run();
  assert.equal(await(await mf.dispatchFetch(base+'/fixture/claim')).json(),null);
  const uncertainState=(await call('get_command_workflow',{workflow_id:uncertain.workflow_id})).data.result.structuredContent;
  assert.equal(uncertainState.status,'needs_attention');assert.equal(uncertainState.global_lock_held,true);
  assert.equal((await db.prepare('SELECT attempts FROM command_jobs WHERE id=?').bind(uncertain.current_job_id).first()).attempts,1);
  assert.equal((await call('start_command_workflow',{mode:'kurum',request_key:'runtime-blocked-after-expiry',requested_at:new Date().toISOString()})).data.result.isError,true);
  const media=await mf.getR2Bucket('COMMAND_MEDIA'),oldId='00000000-0000-4000-8000-000000000001';
  const oldKey=`commands/${oldId}/image.png`,oldPdf=`commands/${oldId}/merged.pdf`,kept=`commands/${oldId}/keep.txt`;
  const template=(await db.prepare('SELECT template_id FROM command_jobs WHERE id=?').bind(run.current_job_id).first()).template_id;
  await db.prepare("INSERT INTO command_jobs(id,template_id,name,steps_json,status,created_at,finished_at,notified_at) VALUES (?,?,'fixture',?,'completed','2026-09-29 08:00:00','2026-09-29 09:00:00','2026-09-29 09:01:00')").bind(oldId,template,JSON.stringify([{botUsername:'fixture_bot',command:'/fixture',delaySeconds:3}])).run();
  await db.prepare("INSERT INTO command_results(job_id,step_index,bot_username,command,response_text,response_kind,media_key) VALUES (?,0,'fixture_bot','/fixture','Preserved runtime text','image',?)").bind(oldId,oldKey).run();
  const resultId=(await db.prepare('SELECT id FROM command_results WHERE job_id=?').bind(oldId).first()).id;
  await media.put(oldKey,'fixture image',{httpMetadata:{contentType:'image/png'}});
  await media.put(oldPdf,'fixture PDF',{httpMetadata:{contentType:'application/pdf'}});
  await media.put(kept,'preserved text',{httpMetadata:{contentType:'text/plain'}});
  await media.put('kap/keep.pdf','unrelated PDF');
  const preview=await(await mf.dispatchFetch(base+'/fixture/retention-preview')).json();
  assert.equal(preview.eligible_jobs,1);assert.deepEqual(preview.jobs[0].files.map(f=>f.key).sort(),[oldKey,oldPdf].sort());
  assert.ok(await media.head(oldKey));assert.equal((await db.prepare('SELECT COUNT(*) n FROM command_media_expirations').first()).n,0);
  const cleaned=await(await mf.dispatchFetch(base+'/fixture/retention-delete')).json();
  assert.equal(cleaned.deleted_objects,2);assert.equal(await media.head(oldKey),null);assert.equal(await media.head(oldPdf),null);
  assert.ok(await media.head(kept));assert.ok(await media.head('kap/keep.pdf'));
  const retained=await(await mf.dispatchFetch(base+'/fixture/retention-read')).json();
  assert.ok(retained.full_text.includes('Preserved runtime text'));assert.equal(retained.results[0].media_state,'expired');assert.equal(retained.result_set_complete,false);
  assert.equal((await mf.dispatchFetch(base+'/fixture/retention-media?id='+resultId)).status,410);
  console.log('Workerd + D1 + R2 retention fixture PASS: pure preview, exact previous-day keys, image/PDF expiry, preserved text/unrelated objects and stale media 410.');
  console.log('Workerd + D1 fixture PASS: explicit single Genel Kurum /kurum text,  RS256 read/run boundaries, concurrent idempotency/claim/transition, exact Terane→Kurum, failed retry no rerun, offline cancellation, expired-lease global lock.');
}finally{await mf.dispose();}
