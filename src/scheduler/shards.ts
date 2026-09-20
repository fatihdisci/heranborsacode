import { DurableObject } from "cloudflare:workers";
import { pollPublicKAPBackfill, pollPublicKAPLive } from "../kap/public";
import { pollRSSSource } from "../rss/poll";
import { RSS_SOURCES } from "../rss/sources";
import { pollSPK } from "../spk/poll";
import type { Env } from "../types";

export const POLL_TASKS = [
  ...RSS_SOURCES.map((_, index) => `rss:${index}`),
  "kap:live",
  "kap:backfill",
  "spk",
] as const;

type PollTask = (typeof POLL_TASKS)[number];
const KAP_CATCH_UP_DELAY_MS = 5_000;

function isPollTask(value: string | null | undefined): value is PollTask {
  return typeof value === "string" && (POLL_TASKS as readonly string[]).includes(value);
}

function nextMinuteBoundary(now = Date.now()): number {
  return Math.floor(now / 60_000) * 60_000 + 60_000;
}

function nextSpkRun(now = Date.now()): number {
  const candidate = new Date(now + 60_000);
  candidate.setUTCSeconds(0, 0);
  const istanbulHours = new Set([0, 8, 10, 12, 14, 16, 18, 20, 22]);
  for (let minutes = 0; minutes <= 24 * 60; minutes++) {
    const istanbulHour = (candidate.getUTCHours() + 3) % 24;
    if (candidate.getUTCMinutes() === 0 && istanbulHours.has(istanbulHour)) return candidate.getTime();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return nextMinuteBoundary(now);
}

export function nextAlarmAt(task: PollTask, now = Date.now()): number {
  if (task === "kap:live") return now + 30_000;
  if (task === "kap:backfill") return now + 10 * 60_000;
  if (task === "spk") return nextSpkRun(now);
  return nextMinuteBoundary(now);
}

async function runTask(env: Env, task: PollTask): Promise<number | null> {
  if (task.startsWith("rss:")) {
    const source = RSS_SOURCES[Number(task.slice(4))];
    if (!source) throw new Error(`Unknown RSS shard ${task}`);
    await pollRSSSource(env, source);
    return null;
  }
  if (task === "kap:live") {
    const result = await pollPublicKAPLive(env);
    // Three consecutive valid IDs mean there may be a queue. Keep the CPU
    // budget fixed per alarm, but temporarily accelerate until the live edge.
    return result.reachedEdge ? null : KAP_CATCH_UP_DELAY_MS;
  }
  if (task === "kap:backfill") {
    await pollPublicKAPBackfill(env);
    return null;
  }
  await pollSPK(env);
  return null;
}

async function recordResult(env: Env, task: PollTask, startedAt: string, error: string | null): Promise<void> {
  const value = JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), error });
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(`poll_shard:${task}`, value).run();
}

export class PollShard extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const task = new URL(request.url).searchParams.get("task");
    if (!isPollTask(task)) return new Response("invalid task", { status: 400 });
    const current = await this.ctx.storage.get<string>("task");
    if (current !== task) await this.ctx.storage.put("task", task);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return new Response("scheduled");
  }

  async alarm(): Promise<void> {
    const task = await this.ctx.storage.get<string>("task");
    if (!isPollTask(task)) return;
    const startedAt = new Date().toISOString();
    let error: string | null = null;
    let nextDelayMs: number | null = null;
    try {
      nextDelayMs = await runTask(this.env, task);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      console.error("poll shard failed", { task, error });
    } finally {
      await this.ctx.storage.setAlarm(nextDelayMs === null ? nextAlarmAt(task) : Date.now() + nextDelayMs);
      await recordResult(this.env, task, startedAt, error);
    }
  }
}

export async function ensurePollingShards(env: Env): Promise<void> {
  const outcomes = await Promise.allSettled(POLL_TASKS.map(async task => {
    const id = env.POLL_SHARDS.idFromName(task);
    const response = await env.POLL_SHARDS.get(id).fetch(`https://poll-shard.internal/ensure?task=${encodeURIComponent(task)}`);
    if (!response.ok) throw new Error(`${task} supervisor HTTP ${response.status}`);
  }));
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") console.error("poll shard supervisor failed", { task: POLL_TASKS[index], error: String(outcome.reason) });
  }
}
