import { getPreferences, savePreferences, TOPICS, decide } from "../notifications/rules";
import { getIndices } from "../notifications/indices";
import { X_ACCOUNTS } from "../x/sources";
import type { Env, FeedType } from "../types";
import { listFeed } from "../db/feed";
import { json } from "../utils/http";
import { generateTweetDraft } from "../ai/tweet";
import { authorizeTelegramRequest } from "../security/telegram";
import { authorizeExtension, takeExtensionRateSlot } from "../security/extension";
import { readerContent } from '../reader/content';
import { RSS_SOURCES } from '../rss/sources';
import { generateXDraft, parseXDraftInput } from '../ai/x-draft';

const TYPES = new Set<FeedType>(["kap", "spk", "news"]);

function extensionCorsHeaders(request:Request):HeadersInit {
  const origin=request.headers.get('origin')??'';
  if(!/^safari-web-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(origin))return {};
  return {'access-control-allow-origin':origin,'access-control-allow-methods':'POST','access-control-allow-headers':'authorization,content-type','access-control-max-age':'600','vary':'Origin'};
}

export async function api(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if(url.pathname==='/api/notification-preferences') {
    if(!await authorizeTelegramRequest(request,env))return json({error:'unauthorized'},401);
    if(request.method==='GET')return json({preferences:await getPreferences(env),indices:await getIndices(env),topics:TOPICS},200,{'cache-control':'no-store'});
    if(request.method!=='PUT')return json({error:'method_not_allowed'},405,{allow:'GET, PUT'});
    let value:unknown;
    try {const raw=await request.text();if(raw.length>25000)return json({error:'payload_too_large'},413);value=JSON.parse(raw);}catch{return json({error:'invalid_json'},400);}
    try {return json({preferences:await savePreferences(env,value)},200,{'cache-control':'no-store'});}
    catch(error){if(error instanceof Error&&error.message==='Geçersiz bildirim kuralı')return json({error:'invalid_preferences'},400);throw error;}
  }
  if(url.pathname==='/api/x-draft') {
    const cors=extensionCorsHeaders(request);
    const reply=(data:unknown,status=200,headers:HeadersInit={})=>json(data,status,{...cors,...headers});
    if(request.method==='OPTIONS')return Object.keys(cors).length?new Response(null,{status:204,headers:cors}):reply({error:'forbidden_origin'},403);
    if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
    if(!env.SAFARI_EXTENSION_TOKEN||env.SAFARI_EXTENSION_TOKEN.length<32)return reply({error:'extension_not_configured'},503);
    if(!await authorizeExtension(request,env))return reply({error:'unauthorized'},401);
    if(!env.OPENAI_API_KEY)return reply({error:'openai_not_configured'},503);
    let body:unknown;
    try {
      const raw=await request.text();
      if(raw.length>15_000)return reply({error:'payload_too_large'},413);
      body=JSON.parse(raw);
    } catch {return reply({error:'invalid_json'},400);}
    const input=parseXDraftInput(body);
    if(!input)return reply({error:'invalid_input'},400);
    if(!await takeExtensionRateSlot(env))return reply({error:'rate_limited'},429,{'retry-after':'60'});
    try {return reply({draft:await generateXDraft(env,input)});}
    catch(error) {
      console.error('Heran Borsa X taslağı üretilemedi',{reason:error instanceof Error?error.message.slice(0,200):'unknown'});
      return reply({error:'draft_generation_failed'},502);
    }
  }
  if (url.pathname === '/api/content') {
    if (request.method !== 'GET') return json({error:'method_not_allowed'},405,{allow:'GET'});
    const id = Number(url.searchParams.get('id'));
    if (!Number.isSafeInteger(id) || id < 1) return json({error:'invalid_feed_item'},400);
    const item = await env.DB.prepare('SELECT * FROM feed_items WHERE id=? AND category IS NULL').bind(id).first<import('../types').FeedItem>();
    if (!item) return json({error:'not_found'},404);
    if (item.type === 'spk' || (item.type === 'kap' && /devre kesici/i.test(item.title))) return json({error:'source_only'},422);
    if (!await authorizeTelegramRequest(request,env)) return json({error:'unauthorized'},401);
    try {
      const content = await readerContent(env,item);
      return content ? json(content) : json({status:'loading'},202,{'retry-after':'2'});
    } catch { return json({error:'content_unavailable'},503); }
  }
  if (url.pathname === "/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      const cron = await env.DB.prepare("SELECT key,value FROM system_state WHERE key IN ('cron_last_started_at','cron_last_finished_at')").all<{ key: string; value: string }>();
      const cronState = Object.fromEntries((cron.results ?? []).map(row => [row.key, row.value]));
      const shards = await env.DB.prepare("SELECT key,value FROM system_state WHERE key LIKE 'poll_shard:%' ORDER BY key").all<{ key: string; value: string }>();
      const activeTasks = new Set<string>([...RSS_SOURCES.map((_, index) => `rss:${index}`), 'kap:live', 'kap:backfill', 'spk', 'telegram', 'monitor']);
      if (env.X_NITTER_BASE_URL) X_ACCOUNTS.forEach(account => activeTasks.add(`x:${account}`));
      const shardState = Object.fromEntries((shards.results ?? []).filter(row => activeTasks.has(row.key.slice('poll_shard:'.length))).map(row => {
        try { return [row.key.slice("poll_shard:".length), JSON.parse(row.value)]; }
        catch { return [row.key.slice("poll_shard:".length), { error: "invalid_state" }]; }
      }));
      const ops = await env.DB.prepare("SELECT value FROM system_state WHERE key='operations_status'").first<{value:string}>();
      return json({ ok: true, service: "heranborsa", database: "connected", cron: { lastStartedAt: cronState.cron_last_started_at ?? null, lastFinishedAt: cronState.cron_last_finished_at ?? null }, shards: shardState, operations:ops ? JSON.parse(ops.value) : null, timestamp: new Date().toISOString() });
    } catch {
      return json({ ok: false, service: "heranborsa", database: "unavailable" }, 503);
    }
  }
  if (url.pathname === '/api/delivery') {
    if (!await authorizeTelegramRequest(request,env)) return json({error:'unauthorized'},401);
    const ref = url.searchParams.get('sourceRef');
    if (!ref) return json({error:'source_ref_required'},400);
    const rows = await env.DB.prepare(`SELECT source_ref,status,published_at,first_seen_at,sent_at,attempts,last_error,message_id,
      ROUND((julianday(sent_at)-julianday(first_seen_at))*86400,1) AS delivery_seconds,
      ROUND((julianday(first_seen_at)-julianday(published_at))*86400,1) AS publication_to_seen_seconds
      FROM telegram_outbox WHERE source_ref=?`).bind(ref).all();
    return json({items:rows.results ?? [],note:'first_seen_at bizim ilk gördüğümüz andır; RSS’e gerçek eklenme anı değildir. sent_at Telegram API kabul zamanıdır.'});
  }
  if (url.pathname === "/api/sources" && request.method === "GET") {
    if (!await authorizeTelegramRequest(request,env)) return json({error:'unauthorized'},401);
    const sources = await env.DB.prepare("SELECT DISTINCT source FROM feed_items WHERE category IS NULL AND type IN ('kap','spk','news') ORDER BY source COLLATE NOCASE").all<{ source: string }>();
    return json({ sources: (sources.results ?? []).map(row => row.source) }, 200, { "cache-control": "public, max-age=60" });
  }
  if (url.pathname === "/api/tweet-draft") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    if (!await authorizeTelegramRequest(request, env)) return json({ error: "unauthorized" }, 401);
    if (!env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 503);
    let feedItemId: number;
    let regenerate = false;
    let instruction = '';
    try {
      const body = await request.json<{ feedItemId?: unknown; regenerate?: unknown; instruction?: unknown }>();
      feedItemId = Number(body.feedItemId);
      if (body.regenerate !== undefined && typeof body.regenerate !== 'boolean') return json({error:'invalid_regenerate'},400);
      if (body.instruction !== undefined && typeof body.instruction !== 'string') return json({error:'invalid_instruction'},400);
      regenerate = body.regenerate === true;
      instruction = (body.instruction as string | undefined)?.trim() ?? '';
    } catch { return json({ error: "invalid_json" }, 400); }
    if (!Number.isSafeInteger(feedItemId) || feedItemId < 1) return json({ error: "invalid_feed_item" }, 400);
    if (instruction.length > 500) return json({error:'instruction_too_long'},400);
    const item = await env.DB.prepare("SELECT * FROM feed_items WHERE id=? AND category IS NULL").bind(feedItemId).first<import("../types").FeedItem>();
    if (!item) return json({ error: "not_found" }, 404);
    try {
      const draft = await generateTweetDraft(env, item, {regenerate,instruction});
      return json(draft);
    } catch (error) {
      console.error("AI tweet generation failed", { feedItemId, error: error instanceof Error ? error.message : String(error) });
      return json({ error: "tweet_generation_failed" }, 502);
    }
  }
  if (url.pathname !== "/api/feed") return null;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
  if (!await authorizeTelegramRequest(request,env)) return json({error:'unauthorized'},401);
  const requestedType = url.searchParams.get("type");
  if (requestedType && !TYPES.has(requestedType as FeedType)) return json({ error: "invalid_type" }, 400);
  const rawLimit = Number(url.searchParams.get("limit") ?? "30");
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 30;
  const rawCursor = url.searchParams.get("cursor");
  const cursorParts = rawCursor?.split("|");
  const cursor = cursorParts?.length === 2 && !Number.isNaN(Date.parse(cursorParts[0])) && /^\d+$/.test(cursorParts[1]) ? { time: cursorParts[0], id: Number(cursorParts[1]) } : undefined;
  const ticker = url.searchParams.get("ticker")?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || undefined;
  const q = url.searchParams.get("q")?.trim().slice(0, 120) || undefined;
  const source = url.searchParams.get("source")?.trim().slice(0, 100) || undefined;
  const scope=url.searchParams.get('scope')??'';
  if(!['','watchlist','bist30','bist100'].includes(scope))return json({error:'invalid_scope'},400);
  const preferences=await getPreferences(env),indices=await getIndices(env);
  const tickerList=scope==='watchlist'?preferences.watchlist.map(w=>w.ticker):scope==='bist30'?indices.bist30:scope==='bist100'?indices.bist100:undefined;
  const result = await listFeed(env, { type: requestedType as FeedType | undefined, ticker, q, source, cursor, limit, tickerList });
  return json({...result,items:result.items.map(item=>({...item,notification:decide(item,preferences,indices)})),indicesCheckedAt:indices.checkedAt}, 200, { "cache-control": "no-store" });
}
