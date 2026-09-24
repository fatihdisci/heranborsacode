import {describe,it,expect,vi,afterEach} from 'vitest';
import {api} from '../src/api/routes';
import {X_DRAFT_PROMPT,parseXDraftInput} from '../src/ai/x-draft';
// @ts-ignore Node SQLite test harness has no TypeScript declarations.
import {database} from './db-harness.js';

const endpoint='https://example.test/api/x-draft';
const secret='test-extension-token-with-at-least-32-chars';
const reference={id:'1234567890123456789',url:'https://x.com/example/status/1234567890123456789',authorHandle:'example',text:'Codex limits have been reset for all users.'};
function request(body:unknown,token=secret):Request {return new Request(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});}
function setup() {const {sql,env}=database();env.SAFARI_EXTENSION_TOKEN=secret;env.OPENAI_API_KEY='test-only';return {sql,env};}
afterEach(()=>vi.unstubAllGlobals());

describe('Safari extension endpoint',()=>{
 it('answers Safari preflight and includes CORS on the authenticated response',async()=>{
  const {env}=setup();
  const origin='safari-web-extension://cc34eec5-5987-4202-8a19-bd8ca75dfcda';
  const preflight=await api(new Request(endpoint,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}}),env as any);
  expect(preflight?.status).toBe(204);
  expect(preflight?.headers.get('access-control-allow-origin')).toBe(origin);
  expect(preflight?.headers.get('access-control-allow-headers')).toContain('authorization');
  expect((await api(new Request(endpoint,{method:'OPTIONS',headers:{origin:'https://evil.test'}}),env as any))?.status).toBe(403);
  const unauthorized=await api(new Request(endpoint,{method:'POST',headers:{origin,authorization:'Bearer wrong','content-type':'application/json'},body:'{}'}),env as any);
  expect(unauthorized?.status).toBe(401);
  expect(unauthorized?.headers.get('access-control-allow-origin')).toBe(origin);
 });
 it('accepts its own token and rejects wrong token before AI generation',async()=>{
  const {env}=setup();const fetchMock=vi.fn(async()=>new Response(JSON.stringify({status:'completed',output_text:'Codex limitleri sıfırlandı.'}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetchMock);
  expect((await api(request({mode:'reply',userNote:'',reference},'wrong-token'),env as any))?.status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
  const good=await api(request({mode:'reply',userNote:'',reference}),env as any);
  expect(good?.status).toBe(200);expect(await good?.json()).toEqual({draft:'Codex limitleri sıfırlandı.'});
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it('validates reply and quote input and normalizes X URLs without fetching them',async()=>{
  const {env}=setup();
  expect(parseXDraftInput({mode:'reply',reference:{text:''}})).toBeNull();
  expect(parseXDraftInput({mode:'quote',reference:{...reference,url:'https://internal.example/status/1234567890123456789'}})).toBeNull();
  expect(parseXDraftInput({mode:'quote',reference:{...reference,id:'99999999'}})).toBeNull();
  expect(parseXDraftInput({mode:'quote',reference,userNote:''})?.mode).toBe('quote');
  expect((await api(request({mode:'reply',reference:{text:''},userNote:''}),env as any))?.status).toBe(400);
  expect((await api(request({mode:'quote',reference:{...reference,url:'https://127.0.0.1/status/1234567890123456789'},userNote:''}),env as any))?.status).toBe(400);
 });
 it('sends an English reference and user note to one shared Responses call for both modes',async()=>{
  const {env}=setup();const calls:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
   expect(url).toBe('https://api.openai.com/v1/responses');
   const body=JSON.parse(init.body);calls.push(body);
   return new Response(JSON.stringify({status:'completed',output_text:'Codex limitleri sıfırlandı. Haftalık limitimi de yeni bitirmiştim :)'}),{headers:{'content-type':'application/json'}});
  }));
  for(const mode of ['reply','quote']) {
   const response=await api(request({mode,reference,userNote:'Haftalık limitimi yeni bitirmiştim'}),env as any);
   expect(response?.status).toBe(200);
   expect((await response?.json() as any).draft).toContain('Haftalık limitimi');
  }
  expect(calls).toHaveLength(2);
  for(const [index,call] of calls.entries()) {
   expect(call.model).toBe('gpt-6-luna');
   const input=JSON.parse(call.input[0].content[0].text);
   expect(input.mode).toBe(index===0?'reply':'quote');
   expect(input.referenceTweet.text).toBe(reference.text);
   expect(input.userNote).toBe('Haftalık limitimi yeni bitirmiştim');
  }
  expect(X_DRAFT_PROMPT).toContain('Tweetin iddiasını mutlak gerçek diye yükseltme');
  expect(X_DRAFT_PROMPT).toContain('Yalnız Türkçe nihai taslağı');
 });
 it('rejects invented personal experience and hashtags in model output when no note exists',async()=>{
  const {env}=setup();let output='Ben Codex limitimi bitirmiştim.';
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({status:'completed',output_text:output}),{headers:{'content-type':'application/json'}})));
  expect((await api(request({mode:'reply',reference,userNote:''}),env as any))?.status).toBe(502);
  output='Codex limitleri sıfırlandı. #AI';
  expect((await api(request({mode:'quote',reference,userNote:''}),env as any))?.status).toBe(502);
 });
 it('limits each minute to 15 generations',async()=>{
  const {env}=setup();const fetchMock=vi.fn(async()=>new Response(JSON.stringify({status:'completed',output_text:'Codex limitleri sıfırlandı.'}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetchMock);
  for(let n=0;n<15;n++) expect((await api(request({mode:'reply',reference,userNote:''}),env as any))?.status).toBe(200);
  expect((await api(request({mode:'reply',reference,userNote:''}),env as any))?.status).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(15);
 });
});
