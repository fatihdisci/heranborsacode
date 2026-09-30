import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from './db-harness';
import worker from '../src/index';
import { commandRoutes } from '../src/commands/routes';
import { resultsReaderRoutes } from '../src/commands/reader-routes';
import { authorizeResultsReader, RESULTS_SCOPE, readerConfig } from '../src/security/results-reader';
import { getReaderJob, listReaderJobs, READER_TEMPLATES, utcTimestamp } from '../src/commands/reader';

// The Node suite exercises fetch routing, not Durable Object runtime behavior.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const origin = 'https://worker.test';
const resource = origin + '/api/command-results/mcp';
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const hiddenId = '33333333-3333-4333-8333-333333333333';
const metadataPath = '/.well-known/oauth-protected-resource/api/command-results/mcp';
const ctx = { waitUntil: vi.fn() };
let privateKey, publicKey, attackerKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  privateKey = pair.privateKey;
  publicKey = {...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'fixture-key',alg:'RS256',use:'sig'};
  attackerKey = (await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify'])).privateKey;
});
afterEach(() => { vi.unstubAllGlobals(); ctx.waitUntil.mockClear(); });
const b64 = data => Buffer.from(data).toString('base64url');
async function token(overrides={}, header={}, key=privateKey) {
  const seconds = Math.floor(Date.now()/1000);
  const claims = {iss:'https://issuer.test/',sub:'owner-fixture',aud:resource,exp:seconds+3600,iat:seconds,scope:RESULTS_SCOPE,...overrides};
  const input = b64(JSON.stringify({alg:'RS256',kid:'fixture-key',...header})) + '.' + b64(JSON.stringify(claims));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(input));
  return input + '.' + b64(signature);
}
function configured(extra={}) {
  return {RESULTS_READ_ENABLED:'true',RESULTS_OAUTH_ISSUER:'https://issuer.test/',RESULTS_OAUTH_JWKS_URL:'https://issuer.test/jwks',RESULTS_OAUTH_SUBJECT:'owner-fixture',PUBLIC_BASE_URL:origin,...extra};
}
function stubJwks() {
  const mock=vi.fn(async input => {
    if (input !== 'https://issuer.test/jwks') throw new Error('Unexpected external request');
    return new Response(JSON.stringify({keys:[publicKey]}),{headers:{'content-type':'application/json'}});
  });
  vi.stubGlobal('fetch',mock);
  return mock;
}
function request(path, bearer, options={}) {
  return new Request(origin + path,{...options,headers:{...(bearer?{authorization:'Bearer '+bearer}:{}),...options.headers}});
}
function rpc(method, params={}, bearer, options={}) {
  return request('/api/command-results/mcp',bearer,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...options.headers}});
}
async function call(env,name,args,bearer) {
  return resultsReaderRoutes(rpc('tools/call',{name,arguments:args},bearer),env);
}
function seed(sql,jobId=id,{template=READER_TEMPLATES.kurum,status='completed',createdAt='2026-09-29 08:00:00',steps=2}={}) {
  sql.prepare('INSERT INTO command_jobs(id,template_id,name,steps_json,status,created_at,finished_at) VALUES (?,?,?,?,?,?,?)')
    .run(jobId,template,'Fixture',JSON.stringify(Array.from({length:steps},(_,i)=>({botUsername:'b0pt_bot',command:'/kurum '+i,delaySeconds:3}))),status,createdAt,status==='queued'||status==='leased'?null:createdAt);
}
function add(sql,{jobId=id,index=0,text='Tam metin',key=null,fileName=null,kind='text',createdAt='2026-09-29 08:01:00'}={}) {
  return Number(sql.prepare('INSERT INTO command_results(job_id,step_index,bot_username,command,response_text,response_kind,media_key,file_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(jobId,index,'b0pt_bot','/kurum '+index,text,kind,key,fileName,createdAt).lastInsertRowid);
}
function fixture() {
  const db=database();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WZkAAAAASUVORK5CYII=','base64');
  const media={get:vi.fn(async()=>({size:png.length,httpMetadata:{contentType:'image/png'},arrayBuffer:async()=>png.buffer.slice(png.byteOffset,png.byteOffset+png.length),body:png})),put:vi.fn(),delete:vi.fn()};
  return {...db,env:{...db.env,...configured(),COMMAND_MEDIA:media,COMMAND_AGENT_TOKEN:'privileged-fixture-token',ASSETS:{fetch:vi.fn(async()=>new Response('asset'))}},media,png};
}

describe('results reader OAuth boundary',()=>{
  it('is inactive unless explicitly enabled and completely configured',async()=>{
    for (const extra of [{RESULTS_READ_ENABLED:undefined},{RESULTS_OAUTH_SUBJECT:undefined},{RESULTS_OAUTH_ISSUER:'http://issuer.test/'},{RESULTS_OAUTH_JWKS_URL:'https://user:pass@issuer.test/jwks'},{PUBLIC_BASE_URL:'https://worker.test/path'}]) {
      expect(readerConfig(configured(extra))).toBeNull();
      expect((await resultsReaderRoutes(request('/api/command-results/jobs'),configured(extra))).status).toBe(503);
    }
  });
  it('accepts only a signed access token for this issuer, resource, owner and exact read scope',async()=>{
    stubJwks();
    expect(await authorizeResultsReader(request('/api/command-results/jobs',await token()),configured())).toBe('authorized');
    expect(await authorizeResultsReader(request('/api/command-results/jobs',await token({aud:[resource,'another-api']})),configured())).toBe('authorized');
  });
  it.each([
    [{iss:'https://attacker.test/'},{}], [{sub:'another-user'},{}], [{aud:'https://other.test/mcp'},{}],
    [{scope:'command-results:read-all'},{}], [{scope:'commands:write'},{}], [{exp:0},{}], [{exp:'9999999999'},{}],
    [{nbf:9999999999},{}], [{iat:9999999999},{}], [{},{alg:'none'}], [{},{alg:'HS256'}], [{},{kid:'not-known'}], [{},{crit:['x']}],
  ])('rejects incorrect claims/header %j %j',async(claims,header)=>{
    stubJwks();
    expect(await authorizeResultsReader(request('/api/command-results/jobs',await token(claims,header)),configured())).toBe('unauthorized');
  });
  it('rejects a tampered signature, unsigned token, URL token, and the command agent key',async()=>{
    stubJwks();
    const valid=await token();
    for (const bearer of [await token({}, {}, attackerKey),'none','privileged-fixture-token',valid.slice(0,-8)+'AAAAAAAA']) {
      expect(await authorizeResultsReader(request('/api/command-results/jobs',bearer),configured())).toBe('unauthorized');
    }
    const response=await resultsReaderRoutes(request('/api/command-results/jobs?access_token='+valid),configured());
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(metadataPath);
  });
  it('fails closed when the issuer keys cannot be fetched; never uses token-controlled URLs',async()=>{
    const fetch=vi.fn(async()=>new Response('down',{status:503}));vi.stubGlobal('fetch',fetch);
    const env=configured({RESULTS_OAUTH_JWKS_URL:'https://unavailable.test/jwks'});
    expect(await authorizeResultsReader(request('/api/command-results/jobs',await token({}, {jku:'https://attacker.test/jwks'})),env)).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://unavailable.test/jwks');
  });
  it('uses Workerd-compatible manual redirects and rejects redirect targets without fetching them',async()=>{
    const fetch=vi.fn(async(_url,init)=>{
      expect(init.redirect).toBe('manual');
      return new Response(null,{status:302,headers:{location:'https://attacker.test/jwks'}});
    });
    vi.stubGlobal('fetch',fetch);
    const env=configured({RESULTS_OAUTH_JWKS_URL:'https://redirect-fixture.test/jwks'});
    expect(await authorizeResultsReader(request('/api/command-results/jobs',await token()),env)).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://redirect-fixture.test/jwks');
  });
  it('does not query private storage before OAuth authorization; validates browser Origin',async()=>{
    const DB={prepare:vi.fn()},COMMAND_MEDIA={get:vi.fn()};
    const env={...configured(),DB,COMMAND_MEDIA};
    expect((await call(env,'get_command_result_job',{job_id:id})).status).toBe(401);
    expect((await resultsReaderRoutes(request('/api/command-results/jobs',undefined,{headers:{origin:'https://evil.test'}}),env)).status).toBe(403);
    expect(DB.prepare).not.toHaveBeenCalled();expect(COMMAND_MEDIA.get).not.toHaveBeenCalled();
  });
});

describe('stored result data contract',()=>{
  it('returns full stored text, all original responses, step identity and distinct UTC timestamps without exposing keys or leases',async()=>{
    const {sql,env}=fixture();
    try {
      seed(sql); add(sql,{text:'Veri alınıyor...'});
      const longText='Satır α\n'.repeat(2200);add(sql,{text:longText});
      add(sql,{index:1,text:'',kind:'image',key:`commands/${id}/private.png`,fileName:'özel.png'});
      sql.prepare('UPDATE command_jobs SET lease_token=?,error=? WHERE id=?').run('private-lease','sensitive-agent-error',id);
      const data=await getReaderJob(env,id,Date.parse('2026-09-30T08:00:00Z'));
      expect(data.job.requested_at).toBe('2026-09-29T08:00:00.000Z');
      expect(data.results[0].recorded_at).toBe('2026-09-29T08:01:00.000Z');
      expect(data.results[0].recorded_age_seconds).toBeGreaterThan(80000);
      expect(data.results[0].source_data_at).toBeNull();expect(data.job.source_freshness).toBe('unknown');
      expect(data.availability).toBe('available');expect(data.result_set_complete).toBe(true);
      expect(data.draft_evidence_state).toBe('requires_content_review');
      expect(data.full_text).toContain(longText);expect(data.results[0].text).toBe(longText);
      expect(data.results).toHaveLength(2);expect(data.stored_responses).toHaveLength(3);
      expect(data.results[1].media.arguments.job_id).toBe(id);
      const encoded=JSON.stringify(data);
      for (const sensitive of ['commands/'+id+'/private.png','media_url','private-lease','sensitive-agent-error']) expect(encoded).not.toContain(sensitive);
    } finally {sql.close();}
  });
  it.each(['queued','leased','completed','failed','cancelled'])('keeps %s status and distinguishes no data from a connection failure',async(status)=>{
    const {sql,env}=fixture();try {
      seed(sql,id,{status});const result=await getReaderJob(env,id);
      expect(result.job.status).toBe(status);
      expect(result.availability).toBe(['queued','leased'].includes(status)?'pending':'empty');
      expect(result.market_state).toBe('unknown');expect(result.empty_reason).toBe('not_inferred');
      expect(result.result_set_complete).toBe(false);expect(result.results).toEqual([]);
    }finally{sql.close();}
  });
  it('marks progress-only, blank and missing steps; never silently substitutes older jobs',async()=>{
    const {sql,env}=fixture();try{
      seed(sql);add(sql,{text:'Veri hazırlanıyor...'});add(sql,{index:1,text:'   '});
      expect((await getReaderJob(env,id)).availability).toBe('empty');
      add(sql,{text:'Kısmi sonuç'});const partial=await getReaderJob(env,id);
      expect(partial.availability).toBe('partial');expect(partial.missing_step_indices).toEqual([1]);expect(partial.result_set_complete).toBe(false);
      seed(sql,otherId,{status:'queued',createdAt:'2026-09-30 08:00:00'});
      const jobs=await listReaderJobs(env,'kurum',10);
      expect(jobs.jobs[0].id).toBe(otherId);expect(jobs.jobs[0].status).toBe('queued');
    }finally{sql.close();}
  });
  it('limits template scope and paginates jobs with a timestamp tie without duplicates',async()=>{
    const {sql,env}=fixture();try{
      seed(sql);seed(sql,otherId);seed(sql,hiddenId,{template:null});
      const first=await listReaderJobs(env,undefined,1);
      const second=await listReaderJobs(env,undefined,1,first.next_cursor);
      expect(first.jobs.map(j=>j.id)).toEqual([otherId]);expect(second.jobs.map(j=>j.id)).toEqual([id]);expect(second.next_cursor).toBeNull();
      await expect(getReaderJob(env,hiddenId)).rejects.toMatchObject({code:'not_found'});
      await expect(listReaderJobs(env,undefined,1,"';DROP TABLE command_jobs")).rejects.toMatchObject({code:'invalid_cursor'});
    }finally{sql.close();}
  });
  it('does not invent a timezone for ambiguous source values',()=>{
    expect(utcTimestamp('2026-09-29 08:00:00')).toBe('2026-09-29T08:00:00.000Z');
    expect(utcTimestamp('2026-09-29T11:00:00+03:00')).toBe('2026-09-29T08:00:00.000Z');
    expect(utcTimestamp('2026-09-29T08:00:00')).toBeNull();expect(utcTimestamp('invalid')).toBeNull();
  });
});

describe('MCP and REST integration',()=>{
  it('discovers read-only tools and OAuth metadata through the actual Worker; no private data is exposed by discovery',async()=>{
    const {sql,env}=fixture();try{
      const init=await worker.fetch(rpc('initialize',{protocolVersion:'2026-07-28',capabilities:{},clientInfo:{name:'fixture',version:'1'}}),env,ctx);
      expect((await init.json()).result.protocolVersion).toBe('2025-06-18');
      const discovery=await worker.fetch(rpc('tools/list'),env,ctx);const toolList=(await discovery.json()).result.tools;
      expect(toolList.map(t=>t.name)).toEqual(['list_command_result_jobs','get_command_result_job','get_command_result_media']);
      for(const tool of toolList){expect(tool.annotations.readOnlyHint).toBe(true);expect(tool.securitySchemes[0].scopes).toEqual([RESULTS_SCOPE]);}
      expect(init.headers.get('x-robots-tag')).toContain('noindex');
      const meta=await worker.fetch(request(metadataPath),env,ctx);
      expect(await meta.json()).toMatchObject({resource,authorization_servers:['https://issuer.test/']});
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();expect(ctx.waitUntil).not.toHaveBeenCalled();
    }finally{sql.close();}
  });
  it('lets an authenticated MCP client list, read and retrieve the actual image without Telegram downloads; storage stays read-only',async()=>{
    stubJwks();const bearer=await token();const {sql,env,media,png}=fixture();try{
      seed(sql,id,{steps:1});const resultId=add(sql,{kind:'image',text:'Kaynak metin',key:`commands/${id}/image.png`,fileName:'image.png'});
      const before=sql.prepare('SELECT * FROM command_jobs').all();
      const queries=[];const original=env.DB.prepare;env.DB.prepare=query=>{queries.push(query);return original(query);};
      const listed=await call(env,'list_command_result_jobs',{},bearer);
      expect((await listed.json()).result.structuredContent.jobs[0].id).toBe(id);
      const detail=await call(env,'get_command_result_job',{job_id:id},bearer);
      expect((await detail.json()).result.structuredContent.results[0].text).toBe('Kaynak metin');
      // Listing and re-reading text/pending status must never fetch media implicitly.
      const reread=await call(env,'get_command_result_job',{job_id:id},bearer);
      expect((await reread.json()).result.structuredContent.job.id).toBe(id);
      expect(media.get).not.toHaveBeenCalled();
      const image=await call(env,'get_command_result_media',{job_id:id,result_id:resultId},bearer);
      const content=(await image.json()).result.content;
      expect(content[1]).toMatchObject({type:'image',mimeType:'image/png',data:png.toString('base64')});
      expect(media.get).toHaveBeenCalledTimes(1);
      const raw=await resultsReaderRoutes(request(`/api/command-results/jobs/${id}/media/${resultId}`,bearer),env);
      expect(Buffer.from(await raw.arrayBuffer())).toEqual(png);expect(raw.headers.get('cache-control')).toBe('no-store');
      expect(queries.every(query=>/^SELECT\b/.test(query))).toBe(true);
      expect(sql.prepare('SELECT * FROM command_jobs').all()).toEqual(before);
      expect(media.put).not.toHaveBeenCalled();expect(media.delete).not.toHaveBeenCalled();expect(ctx.waitUntil).not.toHaveBeenCalled();
    }finally{sql.close();}
  });
  it('does not grant enqueue/cancel/upload/agent access to the reader identity',async()=>{
    stubJwks();const bearer=await token();const {sql,env}=fixture();try{
      seed(sql,id,{status:'queued'});
      const paths=[['/api/commands/jobs','POST'],[`/api/commands/jobs/${id}`,'DELETE'],['/api/commands/templates','POST'],['/api/commands/agent/claim','POST'],[`/api/commands/agent/${id}/media`,'POST']];
      for(const [path,method] of paths) expect((await commandRoutes(request(path,bearer,{method,body:'{}'}),env,ctx)).status).toBe(401);
      for(const method of ['POST','PUT','PATCH','DELETE']) expect((await resultsReaderRoutes(request('/api/command-results/jobs',bearer,{method}),env)).status).toBe(405);
      const unknown=await call(env,'enqueue_command_job',{template:'kurum'},bearer);
      expect((await unknown.json()).error.code).toBe(-32602);
      expect(sql.prepare('SELECT status FROM command_jobs WHERE id=?').get(id).status).toBe('queued');
    }finally{sql.close();}
  });
  it('rejects cross-job, out-of-scope and invalid media references, and reports R2 missing media',async()=>{
    stubJwks();const bearer=await token();const {sql,env,media}=fixture();try{
      seed(sql);seed(sql,otherId);seed(sql,hiddenId,{template:null});
      const wrong=add(sql,{key:`commands/${otherId}/secret.png`});
      const hidden=add(sql,{jobId:hiddenId,key:`commands/${hiddenId}/secret.png`});
      const valid=add(sql,{key:`commands/${id}/valid.png`});
      for(const [jobId,resultId] of [[id,wrong],[id,hidden],[otherId,valid],[hiddenId,hidden]]){
        const response=await call(env,'get_command_result_media',{job_id:jobId,result_id:resultId},bearer);
        expect((await response.json()).result.isError).toBe(true);
      }
      expect(media.get).not.toHaveBeenCalled();
      media.get.mockResolvedValue(null);
      const response=await call(env,'get_command_result_media',{job_id:id,result_id:valid},bearer);
      expect((await response.json()).result.content[0].text).toContain('media_missing');
    }finally{sql.close();}
  });
  it('reports oversized media explicitly without reading or truncating it',async()=>{
    stubJwks();const bearer=await token();const {sql,env,media}=fixture();try{
      seed(sql);const result=add(sql,{key:`commands/${id}/big.png`});const arrayBuffer=vi.fn();
      media.get.mockResolvedValue({size:5*1024*1024+1,arrayBuffer});
      const response=await call(env,'get_command_result_media',{job_id:id,result_id:result},bearer);
      expect((await response.json()).result.content[0].text).toContain('media_too_large');expect(arrayBuffer).not.toHaveBeenCalled();
    }finally{sql.close();}
  });
  it('returns PDF as a private blob and rejects unsupported media without pretending it was read',async()=>{
    stubJwks();const bearer=await token();const {sql,env,media}=fixture();try{
      seed(sql);const result=add(sql,{kind:'file',key:`commands/${id}/source.pdf`,fileName:'source.pdf'});
      const pdf=Buffer.from('%PDF-1.7\nfixture');
      media.get.mockResolvedValue({size:pdf.length,arrayBuffer:async()=>pdf.buffer.slice(pdf.byteOffset,pdf.byteOffset+pdf.length)});
      const response=await call(env,'get_command_result_media',{job_id:id,result_id:result},bearer);
      const content=(await response.json()).result.content[1];
      expect(content).toEqual({type:'resource',resource:{uri:`heran-result://${id}/${result}`,mimeType:'application/pdf',blob:pdf.toString('base64')}});
      const html=Buffer.from('<html>private diagnostic</html>');
      media.get.mockResolvedValue({size:html.length,httpMetadata:{contentType:'image/png'},arrayBuffer:async()=>html.buffer.slice(html.byteOffset,html.byteOffset+html.length)});
      const unsupported=await call(env,'get_command_result_media',{job_id:id,result_id:result},bearer);
      expect((await unsupported.json()).result.content[0].text).toContain('unsupported_media');
    }finally{sql.close();}
  });
  it('reports storage failures as errors and does not leak internal diagnostic strings',async()=>{
    stubJwks();const bearer=await token();const env=configured({DB:{prepare(){throw new Error('sensitive-internal-diagnostic');}}});
    const response=await call(env,'get_command_result_job',{job_id:id},bearer);
    const data=await response.json();
    expect(data.result.isError).toBe(true);expect(data.result.content[0].text).toContain('stored_results_unavailable');
    expect(JSON.stringify(data)).not.toContain('sensitive-internal-diagnostic');
    const rest=await resultsReaderRoutes(request('/api/command-results/jobs',bearer),env);
    expect(rest.status).toBe(503);expect(await rest.json()).toEqual({error:'stored_results_unavailable'});
  });
  it('validates transport, JSON-RPC, schemas and unsupported methods',async()=>{
    stubJwks();const bearer=await token();const env=configured();
    expect((await resultsReaderRoutes(request('/api/command-results/mcp'),env)).status).toBe(405);
    expect((await resultsReaderRoutes(rpc('ping',{},undefined,{headers:{'mcp-protocol-version':'invalid'}}),env)).status).toBe(400);
    expect((await resultsReaderRoutes(rpc('ping',{},undefined,{headers:{accept:'application/json'}}),env)).status).toBe(406);
    expect((await resultsReaderRoutes(rpc('ping',{},undefined,{headers:{'content-type':'text/plain'}}),env)).status).toBe(415);
    const oversized=request('/api/command-results/mcp',undefined,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:' '.repeat(33000)});
    expect((await resultsReaderRoutes(oversized,env)).status).toBe(413);
    for(const args of [{template:'unknown'},{template:'__proto__'},{limit:0},{limit:21},{limit:1.5},{extra:true}]){
      expect((await (await call(env,'list_command_result_jobs',args,bearer)).json()).error.code).toBe(-32602);
    }
    expect((await (await resultsReaderRoutes(rpc('resources/read'),env)).json()).error.code).toBe(-32601);
    expect((await (await call(env,'get_command_result_job',{job_id:"' OR 1=1--"},bearer)).json()).error.code).toBe(-32602);
  });
});
