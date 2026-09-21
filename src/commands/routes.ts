import type { Env } from "../types";
import { authorizeTelegramRequest } from "../security/telegram";
import { json } from "../utils/http";
import { escapeTelegramHtml } from "../utils/text";
import { sendMessage, telegramCall } from "../telegram/client";
import { COMMAND_BOTS, validateSteps, type CommandStep } from "./catalog";
import { listBistSymbols } from "./symbols";
import { commandMediaUrl, finalCommandResults, type CommandResultRow } from "./results";

interface CommandJob {
  id: string; name: string; steps_json: string; status: string; lease_token: string | null;
  lease_expires_at: string | null; attempts: number; error: string | null; created_at: string;
  started_at: string | null; finished_at: string | null;
}

interface AgentResult {
  stepIndex?: unknown; botUsername?: unknown; command?: unknown; text?: unknown;
  kind?: unknown; mediaKey?: unknown; fileName?: unknown;
}

function agentAuthorized(request: Request, env: Env): boolean {
  const expected = env.COMMAND_AGENT_TOKEN;
  const received = request.headers.get("authorization");
  if (!expected || !received || received.length !== expected.length + 7) return false;
  const value = received.slice(7);
  if (!received.startsWith("Bearer ") || value.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ value.charCodeAt(i);
  return mismatch === 0;
}

async function body<T>(request: Request): Promise<T | null> {
  try { return await request.json<T>(); } catch { return null; }
}

function templateName(value: unknown): string | null {
  const name = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  return name.length >= 2 ? name : null;
}

function publicJob(row: CommandJob) {
  return { ...row, steps: JSON.parse(row.steps_json), lease_token: undefined, steps_json: undefined };
}

async function telegramAuthorized(request: Request, env: Env): Promise<boolean> {
  return authorizeTelegramRequest(request, env);
}

async function userRoutes(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/commands/catalog" && request.method === "GET") return json({ bots: COMMAND_BOTS });
  if (path === "/api/commands/symbols" && request.method === "GET") {
    return json({ symbols: await listBistSymbols(env) }, 200, { "cache-control": "public, max-age=21600" });
  }
  if (!path.startsWith("/api/commands/")) return null;
  if (!await telegramAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  if (path === "/api/commands/templates") {
    if (request.method === "GET") {
      const rows = await env.DB.prepare("SELECT id,name,steps_json,created_at,updated_at FROM command_templates ORDER BY updated_at DESC").all();
      return json({ templates: (rows.results ?? []).map((row: any) => ({ ...row, steps: JSON.parse(row.steps_json), steps_json: undefined })) });
    }
    if (request.method === "POST") {
      const value = await body<{ id?: unknown; name?: unknown; steps?: unknown }>(request);
      const name = templateName(value?.name), steps = validateSteps(value?.steps);
      if (!name || !steps) return json({ error: "invalid_template" }, 400);
      const id = typeof value?.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) ? value.id : crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO command_templates(id,name,steps_json) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,steps_json=excluded.steps_json,updated_at=CURRENT_TIMESTAMP`)
        .bind(id, name, JSON.stringify(steps)).run();
      return json({ id, name, steps }, 201);
    }
  }

  const templateDelete = path.match(/^\/api\/commands\/templates\/([a-f0-9-]{36})$/);
  if (templateDelete && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM command_templates WHERE id=?").bind(templateDelete[1]).run();
    return json({ ok: true });
  }

  if (path === "/api/commands/jobs") {
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT id,name,steps_json,status,attempts,error,created_at,started_at,finished_at
        FROM command_jobs ORDER BY created_at DESC LIMIT 30`).all<CommandJob>();
      return json({ jobs: (rows.results ?? []).map(publicJob) });
    }
    if (request.method === "POST") {
      const value = await body<{ templateId?: unknown; name?: unknown; steps?: unknown }>(request);
      let steps = validateSteps(value?.steps), name = templateName(value?.name) ?? "Tek seferlik komut";
      let templateId: string | null = null;
      if (typeof value?.templateId === "string") {
        const template = await env.DB.prepare("SELECT id,name,steps_json FROM command_templates WHERE id=?").bind(value.templateId).first<{id:string;name:string;steps_json:string}>();
        if (!template) return json({ error: "template_not_found" }, 404);
        templateId = template.id; name = template.name; steps = validateSteps(JSON.parse(template.steps_json));
      }
      if (!steps) return json({ error: "invalid_steps" }, 400);
      const queued = await env.DB.prepare("SELECT COUNT(*) AS count FROM command_jobs WHERE status IN ('queued','leased')").first<{count:number}>();
      if ((queued?.count ?? 0) >= 20) return json({ error: "queue_full" }, 429);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO command_jobs(id,template_id,name,steps_json) VALUES (?,?,?,?)")
        .bind(id, templateId, name, JSON.stringify(steps)).run();
      return json({ id, name, status: "queued", steps }, 202);
    }
  }

  const jobMatch = path.match(/^\/api\/commands\/jobs\/([a-f0-9-]{36})$/);
  if (jobMatch && request.method === "GET") {
    const job = await env.DB.prepare(`SELECT id,name,steps_json,status,attempts,error,created_at,started_at,finished_at
      FROM command_jobs WHERE id=?`).bind(jobMatch[1]).first<CommandJob>();
    if (!job) return json({ error: "not_found" }, 404);
    const results = await env.DB.prepare("SELECT step_index,bot_username,command,response_text,response_kind,media_key,file_name,created_at FROM command_results WHERE job_id=? ORDER BY step_index,id").bind(job.id).all<CommandResultRow>();
    const visible = finalCommandResults(results.results ?? []).map(({ media_key, ...row }) => ({
      ...row,
      media_url: commandMediaUrl(media_key),
    }));
    return json({ job: publicJob(job), results: visible });
  }
  if (jobMatch && request.method === "DELETE") {
    const changed = await env.DB.prepare("UPDATE command_jobs SET status='cancelled',finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").bind(jobMatch[1]).run();
    return changed.meta.changes ? json({ ok: true }) : json({ error: "not_cancellable" }, 409);
  }
  return null;
}

async function uploadMedia(request: Request, env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare("SELECT lease_token,status FROM command_jobs WHERE id=?").bind(jobId).first<{lease_token:string;status:string}>();
  const leaseToken = request.headers.get("x-command-lease");
  if (!job || job.status !== "leased" || !leaseToken || leaseToken !== job.lease_token) return json({ error: "invalid_lease" }, 409);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 20 * 1024 * 1024) return json({ error: "too_large" }, 413);
  const filename = new URL(request.url).searchParams.get("filename")?.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100) || "dosya";
  const key = `commands/${jobId}/${crypto.randomUUID()}-${filename}`;
  await env.COMMAND_MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" }, customMetadata: { filename } });
  return json({ mediaKey: key, fileName: filename }, 201);
}

async function notifyResults(env: Env, origin: string, jobId: string, name: string): Promise<void> {
  const rows = await env.DB.prepare("SELECT step_index,bot_username,command,response_text,response_kind,media_key,file_name FROM command_results WHERE job_id=? ORDER BY step_index,id").bind(jobId).all<any>();
  await sendMessage(env, `✅ <b>${escapeTelegramHtml(name)}</b> tamamlandı\n${rows.results.length} yanıt alındı.`);
  for (const row of rows.results) {
    const heading = `<b>@${escapeTelegramHtml(row.bot_username)}</b> · <code>${escapeTelegramHtml(row.command)}</code>`;
    const content = String(row.response_text || "").trim();
    if (row.media_key) {
      const encodedKey = String(row.media_key).split('/').map(encodeURIComponent).join('/');
      const url = `${origin}/api/commands/media/${encodedKey}`;
      const form = new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID!, document: url, caption: `${heading}${content ? `\n\n${escapeTelegramHtml(content).slice(0, 800)}` : ""}`, parse_mode: "HTML" });
      await telegramCall(env, "sendDocument", form);
    } else {
      await sendMessage(env, `${heading}${content ? `\n\n${escapeTelegramHtml(content).slice(0, 3500)}` : "\n\nYanıt metni boş."}`);
    }
  }
  await env.DB.prepare("UPDATE command_jobs SET notified_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId).run();
}

async function agentRoutes(request: Request, env: Env, ctx: Pick<ExecutionContext,"waitUntil">, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/commands/agent/")) return null;
  if (!agentAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  if (path === "/api/commands/agent/claim" && request.method === "POST") {
    await env.DB.prepare("INSERT INTO system_state(key,value) VALUES ('command_agent_last_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(new Date().toISOString()).run();
    const token = crypto.randomUUID(), expiry = new Date(Date.now() + 10 * 60_000).toISOString().replace('T',' ').replace(/\.\d{3}Z$/,'');
    const job = await env.DB.prepare(`UPDATE command_jobs SET status='leased',lease_token=?,lease_expires_at=?,attempts=attempts+1,
      started_at=COALESCE(started_at,CURRENT_TIMESTAMP),error=NULL WHERE id=(SELECT id FROM command_jobs
      WHERE status='queued' OR (status='leased' AND lease_expires_at<CURRENT_TIMESTAMP) ORDER BY created_at LIMIT 1)
      RETURNING id,name,steps_json,status,lease_token,lease_expires_at,attempts,error,created_at,started_at,finished_at`)
      .bind(token, expiry).first<CommandJob>();
    if (!job) return new Response(null, { status: 204 });
    return json({ job: publicJob(job), leaseToken: token });
  }

  const media = path.match(/^\/api\/commands\/agent\/([a-f0-9-]{36})\/media$/);
  if (media && request.method === "POST") return uploadMedia(request, env, media[1]);

  const renew = path.match(/^\/api\/commands\/agent\/([a-f0-9-]{36})\/renew$/);
  if (renew && request.method === "POST") {
    const value = await body<{ leaseToken?: unknown }>(request);
    const expiry = new Date(Date.now() + 10 * 60_000).toISOString().replace('T',' ').replace(/\.\d{3}Z$/,'');
    const changed = await env.DB.prepare("UPDATE command_jobs SET lease_expires_at=? WHERE id=? AND status='leased' AND lease_token=?")
      .bind(expiry,renew[1],String(value?.leaseToken ?? '')).run();
    return changed.meta.changes ? json({ok:true}) : json({error:'invalid_lease'},409);
  }

  const complete = path.match(/^\/api\/commands\/agent\/([a-f0-9-]{36})\/complete$/);
  if (complete && request.method === "POST") {
    const value = await body<{ leaseToken?: unknown; status?: unknown; error?: unknown; results?: AgentResult[] }>(request);
    const job = await env.DB.prepare("SELECT id,name,lease_token,status,steps_json FROM command_jobs WHERE id=?").bind(complete[1]).first<CommandJob>();
    if (!job || job.status !== "leased" || typeof value?.leaseToken !== "string" || value.leaseToken !== job.lease_token) return json({ error: "invalid_lease" }, 409);
    const steps = JSON.parse(job.steps_json) as CommandStep[];
    const results = Array.isArray(value.results) ? value.results.slice(0, 160) : [];
    const statements = results.flatMap(raw => {
      const index = Number(raw.stepIndex);
      const step = steps[index];
      if (!step) return [];
      const kind = ["text", "image", "file"].includes(String(raw.kind)) ? String(raw.kind) : "text";
      const text = String(raw.text ?? "").slice(0, 20_000);
      const mediaKey = typeof raw.mediaKey === "string" && raw.mediaKey.startsWith(`commands/${job.id}/`) ? raw.mediaKey : null;
      return [env.DB.prepare(`INSERT INTO command_results(job_id,step_index,bot_username,command,response_text,response_kind,media_key,file_name)
        VALUES (?,?,?,?,?,?,?,?)`).bind(job.id,index,step.botUsername,step.command,text,kind,mediaKey,String(raw.fileName ?? "").slice(0,100) || null)];
    });
    const finalStatus = value.status === "completed" ? "completed" : "failed";
    statements.push(env.DB.prepare("UPDATE command_jobs SET status=?,error=?,lease_token=NULL,lease_expires_at=NULL,finished_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(finalStatus, finalStatus === "failed" ? String(value.error ?? "Ajan işi tamamlayamadı.").slice(0,1000) : null, job.id));
    await env.DB.batch(statements);
    if (finalStatus === "completed") ctx.waitUntil(notifyResults(env, new URL(request.url).origin, job.id, job.name));
    else ctx.waitUntil(sendMessage(env, `⚠️ <b>${escapeTelegramHtml(job.name)}</b> tamamlanamadı. Mini App geçmişinden yeniden deneyebilirsin.`));
    return json({ ok: true });
  }
  return null;
}

export async function commandRoutes(request: Request, env: Env, ctx: Pick<ExecutionContext,"waitUntil">): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const agent = await agentRoutes(request, env, ctx, path);
  if (agent) return agent;
  const media = path.match(/^\/api\/commands\/media\/(commands\/.+)$/);
  if (media && request.method === "GET") {
    const object = await env.COMMAND_MEDIA.get(decodeURIComponent(media[1]));
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("cache-control", "private, max-age=3600");
    const rawName = object.customMetadata?.filename ?? "dosya";
    const asciiName = rawName.replace(/[^\x20-\x7E]|[\"\\]/g, "_");
    headers.set("content-disposition", `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`);
    return new Response(object.body, { headers });
  }
  return userRoutes(request, env, path);
}
