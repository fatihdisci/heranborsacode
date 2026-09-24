import { DurableObject } from "cloudflare:workers";
import { pollSource } from "../sources/poll";
import { SOURCES, sourceById } from "../sources/registry";
import type { Env } from "../types";
import { pollDelivery } from '../telegram/outbox';
import { monitorOperations } from './monitor';

export const POLL_TASKS = [...SOURCES.map(source=>`source:${source.id}`), 'telegram', 'monitor'] as const;

type PollTask = (typeof POLL_TASKS)[number];
function isPollTask(value: string | null | undefined): value is PollTask {
  return typeof value === "string" && (POLL_TASKS as readonly string[]).includes(value);
}

function nextMinuteBoundary(now = Date.now()): number {
  return Math.floor(now / 60_000) * 60_000 + 60_000;
}

export function nextAlarmAt(task: PollTask, now = Date.now()): number {
  if (task === 'telegram') return now + 3000;
  const source=task.startsWith('source:')?sourceById(task.slice(7)):null;
  if (source) return now+source.intervalMinutes*60_000;
  return nextMinuteBoundary(now);
}

async function runTask(env: Env, task: PollTask): Promise<number | null> {
  if (task === 'telegram') return pollDelivery(env);
  if (task === 'monitor') { await monitorOperations(env); return null; }
  const source=sourceById(task.slice(7));
  if (!source) throw new Error(`Unknown source shard ${task}`);
  await pollSource(env,source);
  return null;
}

async function recordResult(env: Env, task: PollTask, startedAt: string, error: string | null, failures: number, lastSuccessAt: string | null, nextScheduledAt: number): Promise<void> {
  const value = JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), error, failures, lastSuccessAt, nextScheduledAt:new Date(nextScheduledAt).toISOString() });
  await env.DB.prepare("INSERT INTO system_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(`poll_shard:${task}`, value).run();
}

export class PollShard extends DurableObject<Env> {
  private lastHealthWrite = 0;
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
      const health = await this.ctx.storage.get<{failures:number;lastSuccessAt:string|null;recordedAt?:number}>('health');
      const previousFailures = health?.failures ?? 0;
      const failures = error ? previousFailures+1 : 0;
      const lastSuccessAt = error ? health?.lastSuccessAt ?? null : new Date().toISOString();
      // Back off each failing upstream independently.
      const next = error ? Date.now()+Math.min(300_000,30_000*2**Math.min(failures-1,4)) : nextDelayMs === null ? nextAlarmAt(task) : Date.now()+nextDelayMs;
      await this.ctx.storage.setAlarm(next);
      // A hot delivery queue must not write a D1 heartbeat for every message.
      if (task !== 'telegram' || error || previousFailures || Date.now()-Math.max(this.lastHealthWrite,health?.recordedAt ?? 0)>=60_000) {
        await this.ctx.storage.put('health',{failures,lastSuccessAt,recordedAt:Date.now()});
        await recordResult(this.env,task,startedAt,error,failures,lastSuccessAt,next);
        this.lastHealthWrite=Date.now();
      }
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
