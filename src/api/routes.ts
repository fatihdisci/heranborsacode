import type { Env, FeedItem } from '../types';
import { SOURCES, type Category } from '../sources/registry';
import { listFeed } from '../db/feed';
import { json } from '../utils/http';
import { generateTweetDraft, type DraftOptions } from '../ai/tweet';
import { authorizeTelegramRequest } from '../security/telegram';
import { readerContent } from '../reader/content';
import { BRAND } from '../config';
import {authorizeExtension,takeExtensionRateSlot} from '../security/extension';
import {generateXDraft,parseXDraftInput} from '../ai/x-draft';

const CATEGORIES=new Set<Category>(['openai','claude','coding','resets','ai-news']);
const itemById=(env:Env,id:number)=>env.DB.prepare('SELECT * FROM feed_items WHERE id=? AND category IS NOT NULL').bind(id).first<FeedItem>();
function extensionCorsHeaders(request:Request):HeadersInit {
  const origin=request.headers.get('origin')??'';
  if(!/^safari-web-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(origin)) return {};
  return {'access-control-allow-origin':origin,'access-control-allow-methods':'POST','access-control-allow-headers':'authorization,content-type','access-control-max-age':'600','vary':'Origin'};
}
export async function api(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url);
  if (url.pathname==='/api/config') return json(BRAND);
  if (url.pathname==='/health') {
    try {
      await env.DB.prepare('SELECT 1').first();
      const rows=await env.DB.prepare("SELECT key,value FROM system_state WHERE key LIKE 'poll_shard:%' OR key IN ('cron_last_started_at','cron_last_finished_at','operations_status','codex_resets_status')").all<{key:string;value:string}>();
      const map=Object.fromEntries((rows.results??[]).map(row=>[row.key,row.value]));
      const shards=Object.fromEntries(SOURCES.map(source=>[source.id,JSON.parse(map[`poll_shard:source:${source.id}`]??'null')]));
      return json({ok:true,service:BRAND.slug,database:'connected',cron:{lastStartedAt:map.cron_last_started_at??null,lastFinishedAt:map.cron_last_finished_at??null},sources:shards,telegram:JSON.parse(map['poll_shard:telegram']??'null'),codexResets:{status:map.codex_resets_status?JSON.parse(map.codex_resets_status):null,source:shards['codex-resets'],attribution:{label:'Codex Resets',url:'https://codex-resets.com/'}},operations:JSON.parse(map.operations_status??'null'),timestamp:new Date().toISOString()});
    } catch {return json({ok:false,service:BRAND.slug,database:'unavailable'},503);}
  }
  if (url.pathname==='/api/x-draft') {
    const cors=extensionCorsHeaders(request);
    const reply=(data:unknown,status=200,headers:HeadersInit={})=>json(data,status,{...cors,...headers});
    if(request.method==='OPTIONS') return Object.keys(cors).length?new Response(null,{status:204,headers:cors}):reply({error:'forbidden_origin'},403);
    if(request.method!=='POST') return reply({error:'method_not_allowed'},405);
    if(!env.SAFARI_EXTENSION_TOKEN||env.SAFARI_EXTENSION_TOKEN.length<32) return reply({error:'extension_not_configured'},503);
    if(!await authorizeExtension(request,env)) return reply({error:'unauthorized'},401);
    if(!env.OPENAI_API_KEY) return reply({error:'openai_not_configured'},503);
    let body:unknown;
    try {
      const raw=await request.text();
      if(raw.length>15_000) return reply({error:'payload_too_large'},413);
      body=JSON.parse(raw);
    } catch {return reply({error:'invalid_json'},400);}
    const input=parseXDraftInput(body);
    if(!input) return reply({error:'invalid_input'},400);
    if(!await takeExtensionRateSlot(env)) return reply({error:'rate_limited'},429,{'retry-after':'60'});
    try {return reply({draft:await generateXDraft(env,input)});}
    catch(error) {console.error('X draft generation failed',{reason:error instanceof Error?error.message.slice(0,200):'unknown'});return reply({error:'draft_generation_failed'},502);}
  }
  if (!['/api/feed','/api/sources','/api/content','/api/tweet-draft','/api/delivery'].includes(url.pathname)) return null;
  if (!await authorizeTelegramRequest(request,env)) return json({error:'unauthorized'},401);
  if (url.pathname==='/api/sources' && request.method!=='GET') return json({error:'method_not_allowed'},405);
  if (url.pathname==='/api/sources') return json({sources:SOURCES.map(source=>({id:source.id,name:source.name,category:source.category}))});
  if (url.pathname==='/api/content') {
    if (request.method!=='GET') return json({error:'method_not_allowed'},405);
    const id=Number(url.searchParams.get('id'));
    if (!Number.isSafeInteger(id)||id<1) return json({error:'invalid_feed_item'},400);
    const item=await itemById(env,id);
    if (!item) return json({error:'not_found'},404);
    try {const content=await readerContent(env,item);return content?json(content):json({status:'loading'},202,{'retry-after':'2'});} catch {return json({error:'content_unavailable'},503);}
  }
  if (url.pathname==='/api/delivery') {
    const ref=url.searchParams.get('sourceRef');
    if (!ref?.startsWith('ai:')) return json({error:'source_ref_required'},400);
    const rows=await env.DB.prepare('SELECT source_ref,status,published_at,first_seen_at,sent_at,attempts,last_error,message_id FROM telegram_outbox WHERE source_ref=?').bind(ref).all();
    return json({items:rows.results??[]});
  }
  if (url.pathname==='/api/tweet-draft') {
    if (request.method!=='POST') return json({error:'method_not_allowed'},405);
    if (!env.OPENAI_API_KEY) return json({error:'openai_not_configured'},503);
    let body:{feedItemId?:unknown;language?:unknown;tone?:unknown;note?:unknown};
    try {body=await request.json();} catch {return json({error:'invalid_json'},400);}
    const id=Number(body.feedItemId);
    if (!Number.isSafeInteger(id)||id<1) return json({error:'invalid_feed_item'},400);
    const language=body.language??'tr',tone=body.tone??'natural',note=body.note??'';
    if (language!=='tr'||!['natural','news','commentary'].includes(String(tone))||typeof note!=='string'||note.length>500) return json({error:'invalid_options'},400);
    const item=await itemById(env,id);
    if (!item) return json({error:'not_found'},404);
    try {return json(await generateTweetDraft(env,item,{language,tone,note} as DraftOptions));}
    catch(error) {console.error('AI tweet generation failed',{feedItemId:id,error:error instanceof Error?error.message:String(error)});return json({error:'tweet_generation_failed'},502);}
  }
  if (request.method!=='GET') return json({error:'method_not_allowed'},405);
  const rawCategory=url.searchParams.get('category');
  if (rawCategory && !CATEGORIES.has(rawCategory as Category)) return json({error:'invalid_category'},400);
  const rawLimit=Number(url.searchParams.get('limit')??'30');
  const limit=Number.isInteger(rawLimit)?Math.max(1,Math.min(rawLimit,100)):30;
  const parts=url.searchParams.get('cursor')?.split('|');
  const cursor=parts?.length===2&&!Number.isNaN(Date.parse(parts[0]))&&/^\d+$/.test(parts[1])?{time:parts[0],id:Number(parts[1])}:undefined;
  const q=url.searchParams.get('q')?.trim().slice(0,120)||undefined;
  const source=url.searchParams.get('source')?.trim().slice(0,100)||undefined;
  return json(await listFeed(env,{category:rawCategory as Category|undefined,q,source,cursor,limit}));
}
