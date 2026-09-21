import { api } from "./api/routes";
import { ensurePollingShards, PollShard } from "./scheduler/shards";
import type { Env } from "./types";
import { ensureTelegramWebhook, telegramRoutes } from './telegram/webhook';
import { ensureTelegramActions } from './telegram/actions';
import { commandRoutes } from './commands/routes';
export { TelegramActions } from './telegram/action-worker';

export { PollShard };

async function runScheduled(env: Env): Promise<void> {
  const startedAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('cron_last_started_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(startedAt).run();
  try {
    // The cron invocation only supervises independent alarm shards. RSS, KAP
    // and SPK no longer share a single free-plan CPU budget.
    await ensurePollingShards(env);
    await ensureTelegramActions(env);
    await ensureTelegramWebhook(env);
  } finally {
    await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('cron_last_finished_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(new Date().toISOString()).run();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const telegram = await telegramRoutes(request,env,ctx);
    if (telegram) return telegram;
    const commands = await commandRoutes(request,env,ctx);
    if (commands) return commands;
    const response = await api(request, env);
    return response ?? env.ASSETS.fetch(request);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  }
} satisfies ExportedHandler<Env>;
