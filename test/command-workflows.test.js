import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from './db-harness';
import { claimCommandJob, getCommandWorkflow, refreshActiveWorkflow, startCommandWorkflow, WORKFLOW_LOCK } from '../src/commands/workflows';
import { READER_TEMPLATES } from '../src/commands/reader';
import { commandRoutes } from '../src/commands/routes';
import { resultsReaderRoutes } from '../src/commands/reader-routes';
import { COMMAND_RUN_SCOPE, RESULTS_SCOPE } from '../src/security/results-reader';

vi.mock('../src/telegram/client',()=>({sendMessage:vi.fn(async()=>1),sendDocument:vi.fn(async()=>1),sendDocumentData:vi.fn(async()=>1),telegramCall:vi.fn(async()=>({}))}));
const now=Date.parse('2026-09-30T08:00:00.000Z'), requested=new Date(now).toISOString();
const owner='owner-workflow-fixture', key='2026-09-30:opening:market_round';
const utc=n=>new Date(n).toISOString().replace('T',' ').slice(0,19);
const steps=n=>Array.from({length:n},(_,i)=>({botUsername:'b0pt_bot',command:'/derinlik FIX'+i,delaySeconds:3}));
function fixture(){
  const db=database();
  const batch=db.env.DB.batch;let serial=Promise.resolve();
  // D1 batches are serialized atomic transactions. SQLite fixture must not BEGIN
  // two overlapping transactions on the same connection when exercising races.
  db.env.DB.batch=stmts=>{const task=serial.then(()=>batch(stmts));serial=task.catch(()=>{});return task;};
  for(const [name,id] of Object.entries(READER_TEMPLATES))db.sql.prepare('UPDATE command_templates SET name=?,steps_json=? WHERE id=?').run(name,JSON.stringify(steps(name==='terane'?3:2)),id);
  return {...db,env:{...db.env,COMMAND_RUN_ENABLED:'true',RESULTS_READ_ENABLED:'true',RESULTS_OAUTH_SUBJECT:owner,
    PUBLIC_BASE_URL:'https://workflow.test',RESULTS_OAUTH_ISSUER:'https://workflow-issuer.test/',RESULTS_OAUTH_JWKS_URL:'https://workflow-issuer.test/jwks',COMMAND_AGENT_TOKEN:'agent-fixture',
    COMMAND_MEDIA:{get:vi.fn(async()=>null),put:vi.fn(),delete:vi.fn()}}};
}
function complete(sql,id,{status='completed',partial=false,empty=false}={}){
  const job=sql.prepare('SELECT steps_json FROM command_jobs WHERE id=?').get(id);
  const plan=JSON.parse(job.steps_json);
  if(!empty)for(let i=0;i<plan.length-(partial?1:0);i++)sql.prepare('INSERT INTO command_results(job_id,step_index,bot_username,command,response_text) VALUES (?,?,?,?,?)').run(id,i,plan[i].botUsername,plan[i].command,'Fixture data '+i);
  sql.prepare("UPDATE command_jobs SET status=?,finished_at=?,lease_token=NULL,lease_expires_at=NULL WHERE id=?").run(status,utc(now+1000),id);
}
const count=sql=>sql.prepare('SELECT COUNT(*) n FROM command_jobs').get().n;
async function start(env,mode='market_round',requestKey=key,at=requested,t=now){return startCommandWorkflow(env,owner,mode,requestKey,at,t);}
afterEach(()=>vi.unstubAllGlobals());

describe('durable bounded command workflows',()=>{
  it('snapshots dynamic template counts and starts Terane only; completes exact Terane then Kurum',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env);expect(run.created).toBe(true);expect(count(sql)).toBe(1);
      expect(run.jobs[0]).toMatchObject({template:'terane',expected_steps:3,status:'queued'});
      expect(run.jobs[1]).toMatchObject({template:'kurum',status:'not_started',expected_steps:2,job_id:null});
      const first=run.current_job_id;
      sql.prepare('UPDATE command_templates SET steps_json=? WHERE id=?').run(JSON.stringify(steps(7)),READER_TEMPLATES.kurum);
      complete(sql,first);await refreshActiveWorkflow(env,now+2000);
      const next=await getCommandWorkflow(env,owner,run.workflow_id,now+2000);
      expect(next.current_index).toBe(1);expect(next.current_job_id).not.toBe(first);expect(count(sql)).toBe(2);
      expect(next.jobs[1]).toMatchObject({template:'kurum',expected_steps:2,status:'queued'});
      expect(JSON.parse(sql.prepare('SELECT steps_json FROM command_jobs WHERE id=?').get(next.current_job_id).steps_json)).toHaveLength(2);
      complete(sql,next.current_job_id);await refreshActiveWorkflow(env,now+3000);
      const done=await getCommandWorkflow(env,owner,run.workflow_id,now+3000);
      expect(done.status).toBe('completed');expect(done.jobs.every(j=>j.result_set_complete)).toBe(true);
      expect(done.source_data_at).toBeNull();expect(done.jobs[0].requested_at).toBe(requested);
      expect(sql.prepare('SELECT value FROM system_state WHERE key=?').get(WORKFLOW_LOCK)).toBeUndefined();
      expect(env.COMMAND_MEDIA.get).not.toHaveBeenCalled();
    }finally{sql.close();}
  });
  it('keeps image-only completion separate from reviewed market evidence or a zero amount',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env,'terane');
      const plan=JSON.parse(sql.prepare('SELECT steps_json FROM command_jobs WHERE id=?').get(run.current_job_id).steps_json);
      for(let i=0;i<plan.length;i++)sql.prepare('INSERT INTO command_results(job_id,step_index,bot_username,command,response_text,response_kind,media_key) VALUES (?,?,?,?,?,?,?)')
        .run(run.current_job_id,i,plan[i].botUsername,plan[i].command,'','image',`commands/${run.current_job_id}/image-${i}.png`);
      sql.prepare("UPDATE command_jobs SET status='completed',finished_at=? WHERE id=?").run(utc(now+1000),run.current_job_id);
      await refreshActiveWorkflow(env,now+2000);
      const done=await getCommandWorkflow(env,owner,run.workflow_id,now+2000);
      expect(done.status).toBe('completed');expect(done.jobs[0].availability).toBe('available');
      expect(done.draft_evidence_state).toBe('requires_content_review');expect(done.source_data_at).toBeNull();
      expect(done).not.toHaveProperty('amount');expect(env.COMMAND_MEDIA.get).not.toHaveBeenCalled();
    }finally{sql.close();}
  });
  it('deduplicates concurrent same-key starts and preserves the run on retry long after completion',async()=>{
    const {sql,env}=fixture();try{
      const runs=await Promise.all(Array.from({length:8},()=>start(env)));
      expect(new Set(runs.map(r=>r.workflow_id)).size).toBe(1);expect(runs.filter(r=>r.created)).toHaveLength(1);expect(count(sql)).toBe(1);
      complete(sql,runs[0].current_job_id,{status:'failed'});await refreshActiveWorkflow(env,now+1000);
      const retry=await start(env,'market_round',key,requested,now+24*3600_000);
      expect(retry.created).toBe(false);expect(retry.status).toBe('failed');expect(count(sql)).toBe(1);
      await expect(start(env,'kurum')).rejects.toMatchObject({code:'idempotency_conflict'});
      await expect(start(env,'market_round',key,new Date(now+1000).toISOString(),now+1000)).rejects.toMatchObject({code:'idempotency_conflict'});
    }finally{sql.close();}
  });
  it('allows only one global/per-owner workflow under racing different keys/owners without orphan jobs',async()=>{
    const {sql,env}=fixture();try{
      const runs=await Promise.allSettled(Array.from({length:6},(_,i)=>startCommandWorkflow(env,'owner'+i,'market_round','global-race-key-'+i,requested,now)));
      expect(runs.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(count(sql)).toBe(1);
      expect(sql.prepare('SELECT COUNT(*) n FROM command_workflows').get().n).toBe(1);
      for(const r of runs.filter(r=>r.status==='rejected'))expect(r.reason.code).toBe('command_queue_busy');
    }finally{sql.close();}
  });
  it('does not mix unrelated jobs and atomically grants at most one agent lease',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env);
      const unrelated=crypto.randomUUID();sql.prepare('INSERT INTO command_jobs(id,name,steps_json,created_at) VALUES (?,?,?,?)').run(unrelated,'Other',JSON.stringify(steps(1)),utc(now-1000));
      const claims=await Promise.all(Array.from({length:8},(_,i)=>claimCommandJob(env,'lease-'+i,utc(now+10*60_000),now)));
      expect(claims.filter(Boolean)).toHaveLength(1);expect(claims.find(Boolean).id).toBe(run.current_job_id);
      expect(sql.prepare('SELECT status FROM command_jobs WHERE id=?').get(unrelated).status).toBe('queued');
      expect(await refreshActiveWorkflow(env,now+1000)).toBe(run.workflow_id);
      complete(sql,run.current_job_id);await Promise.all(Array.from({length:6},()=>refreshActiveWorkflow(env,now+2000)));
      const next=await getCommandWorkflow(env,owner,run.workflow_id,now+2000);expect(count(sql)).toBe(3);
      expect((await claimCommandJob(env,'second',utc(now+10*60_000),now+2000)).id).toBe(next.current_job_id);
    }finally{sql.close();}
  });
  it.each([{status:'failed'},{status:'cancelled'},{partial:true},{empty:true}])('stops on failure/incomplete results %j without silently rerunning or starting Kurum',async options=>{
    const {sql,env}=fixture();try{
      const run=await start(env);complete(sql,run.current_job_id,options);await refreshActiveWorkflow(env,now+1000);
      const result=await getCommandWorkflow(env,owner,run.workflow_id,now+1000);
      expect(result.status).toBe(options.status?'failed':'partial');expect(count(sql)).toBe(1);expect(result.jobs[1].status).toBe('not_started');
      expect((await start(env)).created).toBe(false);expect(count(sql)).toBe(1);
    }finally{sql.close();}
  });
  it('expires a queued package before executing any commands when the agent is offline',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env);
      const observational=await getCommandWorkflow(env,owner,run.workflow_id,now+11*60_000);
      expect(observational.requires_attention).toBe(true);expect(observational.status).toBe('running');
      expect(sql.prepare('SELECT status FROM command_jobs WHERE id=?').get(run.current_job_id).status).toBe('queued');
      expect(await claimCommandJob(env,'late',utc(now+21*60_000),now+11*60_000)).toBeNull();
      expect((await getCommandWorkflow(env,owner,run.workflow_id,now+11*60_000)).status).toBe('timed_out');
      expect(sql.prepare('SELECT status FROM command_jobs WHERE id=?').get(run.current_job_id).status).toBe('cancelled');
    }finally{sql.close();}
  });
  it('keeps a global lock on an expired lease; no agent retry or new workflow; terminal late completion does not start the next job',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env);await claimCommandJob(env,'first',utc(now+10*60_000),now);
      expect(await claimCommandJob(env,'unsafe-retry',utc(now+21*60_000),now+11*60_000)).toBeNull();
      const stopped=await getCommandWorkflow(env,owner,run.workflow_id,now+11*60_000);
      expect(stopped.status).toBe('needs_attention');expect(stopped.requires_attention).toBe(true);
      await expect(start(env,'kurum','new-other-run-key',new Date(now+11*60_000).toISOString(),now+11*60_000)).rejects.toMatchObject({code:'command_queue_busy'});
      expect(sql.prepare('SELECT attempts FROM command_jobs WHERE id=?').get(run.current_job_id).attempts).toBe(1);
      complete(sql,run.current_job_id);await refreshActiveWorkflow(env,now+12*60_000);
      expect((await getCommandWorkflow(env,owner,run.workflow_id,now+12*60_000)).status).toBe('timed_out');expect(count(sql)).toBe(1);
    }finally{sql.close();}
  });
  it('enforces the package deadline even while an agent keeps renewing',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env);await claimCommandJob(env,'first',utc(now+180*60_000),now);
      await refreshActiveWorkflow(env,now+121*60_000);
      expect((await getCommandWorkflow(env,owner,run.workflow_id,now+121*60_000)).error).toBe('workflow_deadline_execution_uncertain');
      expect(count(sql)).toBe(1);
    }finally{sql.close();}
  });
  it('requires fresh canonical UTC timestamps and bounded known-template commands',async()=>{
    const {sql,env}=fixture();try{
      for(const at of ['2026-02-31T08:00:00Z','2026-09-30T08:00:00','2026-09-30T08:00:00+03:00'])await expect(start(env,'kurum',key,at)).rejects.toMatchObject({code:'invalid_run_request'});
      await expect(start(env,'unknown')).rejects.toMatchObject({code:'invalid_run_request'});
      await expect(start(env,'kurum','short')).rejects.toMatchObject({code:'invalid_run_request'});
      await expect(start(env,'kurum',key,new Date(now-11*60_000).toISOString())).rejects.toMatchObject({code:'stale_run_request'});
      for(const candidate of [[{botUsername:'unknown',command:'/kurum foo'}],[{botUsername:'b0pt_bot',command:'/hidden_write'}],steps(81)]){
        sql.prepare('UPDATE command_templates SET steps_json=? WHERE id=?').run(JSON.stringify(candidate),READER_TEMPLATES.kurum);
        await expect(start(env,'kurum')).rejects.toMatchObject({code:'invalid_template_steps'});
      }expect(count(sql)).toBe(0);
    }finally{sql.close();}
  });
  it('permits Son halka arzlar only in its explicit single-template mode, and scopes status to the owner',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env,'sonhalkaarzlar');expect(run.jobs).toHaveLength(1);expect(run.jobs[0].template).toBe('sonhalkaarzlar');
      await expect(getCommandWorkflow(env,'other',run.workflow_id,now)).rejects.toMatchObject({code:'not_found'});
      expect(JSON.stringify(run)).not.toMatch(/owner_sub|lease_token|request_key/);
    }finally{sql.close();}
  });
  it('keeps in-flight locks when new run permission is disabled; legacy path works without the workflow migration',async()=>{
    const {sql,env}=fixture();try{
      const run=await start(env);env.COMMAND_RUN_ENABLED='false';
      await expect(start(env,'kurum')).rejects.toMatchObject({code:'command_runner_disabled'});
      expect((await claimCommandJob(env,'safe',utc(now+10*60_000),now)).id).toBe(run.current_job_id);
    }finally{sql.close();}
    const other=fixture();try{
      other.sql.exec('DROP TABLE command_workflows');other.env.COMMAND_RUN_ENABLED=undefined;
      const id=crypto.randomUUID();other.sql.prepare('INSERT INTO command_jobs(id,name,steps_json) VALUES (?,?,?)').run(id,'Legacy',JSON.stringify(steps(1)));
      expect((await claimCommandJob(other.env,'legacy',utc(Date.now()+10*60_000))).id).toBe(id);
      expect(await claimCommandJob(other.env,'parallel',utc(Date.now()+10*60_000))).toBeNull();
    }finally{other.sql.close();}
  });
  it('makes replayed agent completion unable to duplicate results; advances only stored exact job',async()=>{
    const {sql,env}=fixture();const pending=[];try{
      const t=Date.now(),run=await start(env,'market_round',key,new Date(t).toISOString(),t);
      const claim=await claimCommandJob(env,'agent-lease',utc(t+10*60_000),t);
      const result=JSON.parse(claim.steps_json).map((s,i)=>({stepIndex:i,text:'Bounded fixture',kind:'text'}));
      const req=()=>new Request('https://workflow.test/api/commands/agent/'+run.current_job_id+'/complete',{method:'POST',headers:{authorization:'Bearer agent-fixture','content-type':'application/json'},body:JSON.stringify({leaseToken:'agent-lease',status:'completed',results:result})});
      expect((await commandRoutes(req(),env,{waitUntil:p=>pending.push(p)})).status).toBe(200);
      expect((await commandRoutes(req(),env,{waitUntil:p=>pending.push(p)})).status).toBe(409);
      expect(sql.prepare('SELECT COUNT(*) n FROM command_results WHERE job_id=?').get(run.current_job_id).n).toBe(3);
      expect((await getCommandWorkflow(env,owner,run.workflow_id)).current_index).toBe(1);
      await Promise.all(pending);
    }finally{sql.close();}
  });
});

let privateKey,publicKey;
beforeAll(async()=>{
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  privateKey=pair.privateKey;publicKey={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'workflow-key',use:'sig',alg:'RS256'};
});
async function bearer(scope=RESULTS_SCOPE,overrides={}){
  const b64=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url'),t=Math.floor(Date.now()/1000);
  const input=b64({alg:'RS256',kid:'workflow-key'})+'.'+b64({iss:'https://workflow-issuer.test/',sub:owner,aud:'https://workflow.test/api/command-results/mcp',exp:t+900,iat:t,scope,...overrides});
  return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey,new TextEncoder().encode(input))).toString('base64url');
}
function rpc(method,params={},token){return new Request('https://workflow.test/api/command-results/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
function stubKeys(){vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{expect(init.redirect).toBe('manual');return Response.json({keys:[publicKey]});}));}
describe('separate OAuth run permission and MCP metadata',()=>{
  it('defaults to three read-only tools and introduces only bounded run/status tools when enabled',async()=>{
    const {sql,env}=fixture();try{
      env.COMMAND_RUN_ENABLED=undefined;expect((await (await resultsReaderRoutes(rpc('tools/list'),env)).json()).result.tools).toHaveLength(3);
      env.COMMAND_RUN_ENABLED='true';const tools=(await (await resultsReaderRoutes(rpc('tools/list'),env)).json()).result.tools;
      expect(tools).toHaveLength(5);const run=tools.find(t=>t.name==='start_command_workflow');
      expect(run.annotations).toMatchObject({readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:true});
      expect(run.securitySchemes[0].scopes).toEqual([RESULTS_SCOPE,COMMAND_RUN_SCOPE]);
      expect(tools.find(t=>t.name==='get_command_workflow').annotations.readOnlyHint).toBe(true);
      expect(count(sql)).toBe(0);
    }finally{sql.close();}
  });
  it('rejects read-only, run-without-read, wrong subject/audience and agent credentials before queue mutation',async()=>{
    stubKeys();const {sql,env}=fixture();try{
      for(const token of [await bearer(),await bearer(COMMAND_RUN_SCOPE),await bearer(RESULTS_SCOPE+' '+COMMAND_RUN_SCOPE,{sub:'other'}),await bearer(RESULTS_SCOPE+' '+COMMAND_RUN_SCOPE,{aud:'https://other.test/'}),'agent-fixture']){
        const response=await resultsReaderRoutes(rpc('tools/call',{name:'start_command_workflow',arguments:{request_key:key,requested_at:new Date().toISOString()}},token),env);
        expect(response.status).toBe(401);expect(response.headers.get('www-authenticate')).toContain(COMMAND_RUN_SCOPE);
      }expect(count(sql)).toBe(0);
    }finally{sql.close();}
  });
  it('runs through MCP with both scopes and reads same workflow with the old read-only identity without writes',async()=>{
    stubKeys();const {sql,env}=fixture();try{
      const token=await bearer(RESULTS_SCOPE+' '+COMMAND_RUN_SCOPE),at=new Date().toISOString();
      const response=await resultsReaderRoutes(rpc('tools/call',{name:'start_command_workflow',arguments:{request_key:key,requested_at:at}},token),env);
      const run=(await response.json()).result.structuredContent;expect(run.mode).toBe('market_round');
      const calls=[];const original=env.DB.prepare;env.DB.prepare=q=>{calls.push(q);return original(q);};
      const read=await resultsReaderRoutes(rpc('tools/call',{name:'get_command_workflow',arguments:{workflow_id:run.workflow_id}},await bearer()),env);
      expect((await read.json()).result.structuredContent.current_job_id).toBe(run.current_job_id);
      expect(calls.every(q=>/^SELECT\b/.test(q))).toBe(true);expect(env.COMMAND_MEDIA.get).not.toHaveBeenCalled();
      for(const path of ['/api/commands/agent/claim','/api/commands/templates','/api/commands/jobs']){
        const denied=await commandRoutes(new Request('https://workflow.test'+path,{method:'POST',headers:{authorization:'Bearer '+token},body:'{}'}),env,{waitUntil:vi.fn()});expect(denied.status).toBe(401);
      }
    }finally{sql.close();}
  });
});
