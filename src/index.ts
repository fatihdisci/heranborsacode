import { api } from "./api/routes";
import { pollPublicKAP } from "./kap/public";
import { pollRSS } from "./rss/poll";
import { pollSPK } from "./spk/poll";
import type { Env } from "./types";

async function runScheduled(env: Env): Promise<void> {
  const jobs: Array<Promise<unknown>> = [pollPublicKAP(env), pollRSS(env)];
  if (new Date().getUTCMinutes() === 0) jobs.push(pollSPK(env));
  const outcomes = await Promise.allSettled(jobs);
  for (const outcome of outcomes) if (outcome.status === "rejected") console.error("scheduled job failed", outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
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
