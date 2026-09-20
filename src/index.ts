import { api } from "./api/routes";
import { pollPublicKAP } from "./kap/public";
import { pollRSS } from "./rss/poll";
import { pollSPK } from "./spk/poll";
import type { Env } from "./types";

async function runScheduled(env: Env): Promise<void> {
  const startedAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('cron_last_started_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(startedAt).run();
  try {
    const jobs: Array<Promise<unknown>> = [pollPublicKAP(env), pollRSS(env)];
    const spkHistory = await env.DB.prepare("SELECT value FROM system_state WHERE key='spk_history_initialized'").first();
    const spkDates = await env.DB.prepare("SELECT value FROM system_state WHERE key='spk_history_dates_v2'").first();
    const now = new Date();
    const istanbulHour = (now.getUTCHours() + 3) % 24;
    const spkHours = new Set([0, 8, 10, 12, 14, 16, 18, 20, 22]);
    if ((now.getUTCMinutes() === 0 && spkHours.has(istanbulHour)) || !spkHistory || !spkDates) jobs.push(pollSPK(env));
    const outcomes = await Promise.allSettled(jobs);
    for (const outcome of outcomes) if (outcome.status === "rejected") console.error("scheduled job failed", outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
  } finally {
    await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('cron_last_finished_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(new Date().toISOString()).run();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await api(request, env);
    return response ?? env.ASSETS.fetch(request);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  }
} satisfies ExportedHandler<Env>;
