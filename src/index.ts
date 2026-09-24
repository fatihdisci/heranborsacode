import { api } from "./api/routes";
import { ensurePollingShards, PollShard } from "./scheduler/shards";
import type { Env } from "./types";
import { ensureTelegramWebhook, telegramRoutes } from './telegram/webhook';
import { ensureTelegramActions } from './telegram/actions';
import { cleanupLegacyMessages } from './telegram/cleanup';
export { TelegramActions } from './telegram/action-worker';

export { PollShard };

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function runScheduled(env: Env): Promise<void> {
  const startedAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('cron_last_started_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(startedAt).run();
  try {
    // Independent source alarms and the existing Telegram delivery shard.
    await ensurePollingShards(env);
    await ensureTelegramActions(env);
    await ensureTelegramWebhook(env);
    await cleanupLegacyMessages(env);
  } finally {
    await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('cron_last_finished_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(new Date().toISOString()).run();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=86400',
          'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
        },
      });
    }
    const telegram = await telegramRoutes(request,env,ctx);
    if (telegram) return privateResponse(telegram);
    const response = await api(request, env);
    return privateResponse(response ?? await env.ASSETS.fetch(request));
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  }
} satisfies ExportedHandler<Env>;
