import type { Env } from "../types";
import { validateSteps, type CommandStep } from "./catalog";

export const KURUM_TEMPLATE_ID = "7e8eced2-e884-4a46-9da4-4809a7b96179";
export const TERANE_TEMPLATE_ID = "c7250fb2-82f5-446c-aa89-d2ba2cb1dcf6";
export const SON_HALKA_ARZLAR_TEMPLATE_ID = "d3b5c7ca-f364-4bfc-b9ce-0cbcb7255c5f";

export interface QueuedTemplateJob {
  id: string;
  name: string;
  status: string;
  steps: CommandStep[];
  created: boolean;
}

export async function enqueueTemplateJob(env: Env, templateId: string, requestKey: string | null = null): Promise<QueuedTemplateJob> {
  const template = await env.DB.prepare("SELECT id,name,steps_json FROM command_templates WHERE id=?")
    .bind(templateId).first<{id:string;name:string;steps_json:string}>();
  if (!template) throw new Error("template_not_found");
  const steps = validateSteps(JSON.parse(template.steps_json));
  if (!steps) throw new Error("invalid_steps");

  if (requestKey) {
    const existing = await env.DB.prepare("SELECT id,name,status,steps_json FROM command_jobs WHERE request_key=?")
      .bind(requestKey).first<{id:string;name:string;status:string;steps_json:string}>();
    if (existing) return { id: existing.id, name: existing.name, status: existing.status, steps: JSON.parse(existing.steps_json), created: false };
  }

  const queued = await env.DB.prepare("SELECT COUNT(*) AS count FROM command_jobs WHERE status IN ('queued','leased')").first<{count:number}>();
  if ((queued?.count ?? 0) >= 20) throw new Error("queue_full");
  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO command_jobs(id,template_id,name,steps_json,request_key) VALUES (?,?,?,?,?)")
    .bind(id, template.id, template.name, JSON.stringify(steps), requestKey).run();
  if (!inserted.meta.changes && requestKey) {
    const existing = await env.DB.prepare("SELECT id,name,status,steps_json FROM command_jobs WHERE request_key=?")
      .bind(requestKey).first<{id:string;name:string;status:string;steps_json:string}>();
    if (existing) return { id: existing.id, name: existing.name, status: existing.status, steps: JSON.parse(existing.steps_json), created: false };
  }
  return { id, name: template.name, status: "queued", steps, created: true };
}
