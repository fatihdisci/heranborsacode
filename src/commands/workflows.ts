import type { Env } from "../types";
import { COMMAND_BOTS, validateSteps, type CommandStep } from "./catalog";
import { getReaderJob, JOB_ID, READER_TEMPLATES, ReaderError, utcTimestamp, type ReaderTemplate } from "./reader";

export const WORKFLOW_LOCK = "command_workflow_lock";
export const RUN_MODES = ["market_round", "terane", "kurum", "sonhalkaarzlar", "genelkurum"] as const;
export type RunMode = typeof RUN_MODES[number];
interface Snapshot { template: ReaderTemplate; template_id: string; name: string; steps: CommandStep[]; job_id: string; }
interface Workflow {
  id: string; owner_sub: string; request_key: string; mode: RunMode; status: string;
  snapshots_json: string; current_index: number; current_job_id: string;
  requested_at: string; accepted_at: string; start_before: string; deadline_at: string;
  finished_at: string | null; error: string | null;
}
export const runnerEnabled = (env: Env) => env.COMMAND_RUN_ENABLED === "true";
const sqlTime = (now: number) => new Date(now).toISOString().replace("T", " ").slice(0, 19);
const terminal = new Set(["completed", "failed", "cancelled"]);

function safeSteps(raw: string): CommandStep[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ReaderError("invalid_template_steps", 400); }
  const steps = validateSteps(value);
  if (!steps || steps.some(step => !COMMAND_BOTS.find(bot => bot.username === step.botUsername)?.commands
    .some(command => step.command.split(/\s+/, 1)[0] === "/" + command.id))) throw new ReaderError("invalid_template_steps", 400);
  return steps;
}
function snapshots(row: Workflow): Snapshot[] { return JSON.parse(row.snapshots_json); }
async function byId(env: Env, id: string): Promise<Workflow | null> {
  return env.DB.prepare("SELECT * FROM command_workflows WHERE id=?").bind(id).first<Workflow>();
}
async function byKey(env: Env, owner: string, key: string): Promise<Workflow | null> {
  return env.DB.prepare("SELECT * FROM command_workflows WHERE owner_sub=? AND request_key=?").bind(owner, key).first<Workflow>();
}
function insertJob(env: Env, row: Pick<Workflow, "id">, step: Snapshot, index: number, now: string) {
  return env.DB.prepare(`INSERT OR IGNORE INTO command_jobs(id,template_id,name,steps_json,request_key,created_at)
    SELECT ?,?,?,?, ?,? FROM command_workflows WHERE id=? AND status='running' AND current_index=? AND current_job_id=?`)
    .bind(step.job_id, step.template_id, step.name, JSON.stringify(step.steps), `workflow:${row.id}:${index}`, now, row.id, index, step.job_id);
}

export async function startCommandWorkflow(env: Env, owner: string, mode: RunMode, requestKey: string, requestedAt: string, now = Date.now()) {
  if (!runnerEnabled(env)) throw new ReaderError("command_runner_disabled", 503);
  if (!RUN_MODES.includes(mode) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(requestKey) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(requestedAt) ||
    !Number.isFinite(Date.parse(requestedAt)) ||
    new Date(requestedAt).toISOString() !== requestedAt.replace(/Z$/, requestedAt.includes(".") ? "Z" : ".000Z")) throw new ReaderError("invalid_run_request", 400);
  const existing = await byKey(env, owner, requestKey);
  if (existing) {
    if (existing.mode !== mode || utcTimestamp(existing.requested_at) !== new Date(requestedAt).toISOString()) throw new ReaderError("idempotency_conflict", 409);
    return { created: false, ...await getCommandWorkflow(env, owner, existing.id, now) };
  }
  // Retries may read an old existing run; a NEW stale request must never run late.
  if (Date.parse(requestedAt) < now - 10 * 60_000 || Date.parse(requestedAt) > now + 60_000) throw new ReaderError("stale_run_request", 400);
  const names: ReaderTemplate[] = mode === "market_round" ? ["terane", "kurum"] : [mode];
  const plan: Snapshot[] = [];
  for (const template of names) {
    const row = await env.DB.prepare("SELECT id,name,steps_json FROM command_templates WHERE id=?")
      .bind(READER_TEMPLATES[template]).first<{ id: string; name: string; steps_json: string }>();
    if (!row) throw new ReaderError("template_not_found", 404);
    plan.push({ template, template_id: row.id, name: row.name, steps: safeSteps(row.steps_json), job_id: crypto.randomUUID() });
  }
  const id = crypto.randomUUID(), acceptedAt = sqlTime(now);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO command_workflows
      (id,owner_sub,request_key,mode,status,snapshots_json,current_index,current_job_id,requested_at,accepted_at,start_before,deadline_at)
      SELECT ?,?,?,?,'running',?,0,?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM command_jobs WHERE status IN ('queued','leased'))
      AND NOT EXISTS (SELECT 1 FROM command_workflows WHERE status IN ('running','needs_attention'))`)
      .bind(id, owner, requestKey, mode, JSON.stringify(plan), plan[0].job_id, new Date(requestedAt).toISOString(), acceptedAt,
        sqlTime(now + 10 * 60_000), sqlTime(now + 120 * 60_000)),
    insertJob(env, { id }, plan[0], 0, acceptedAt),
    env.DB.prepare(`INSERT INTO system_state(key,value) SELECT ?,id FROM command_workflows WHERE id=? AND status='running'
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(WORKFLOW_LOCK, id),
  ]);
  const admitted = await byKey(env, owner, requestKey);
  if (!admitted) throw new ReaderError("command_queue_busy", 409);
  if (admitted.mode !== mode || utcTimestamp(admitted.requested_at) !== new Date(requestedAt).toISOString()) throw new ReaderError("idempotency_conflict", 409);
  return { created: admitted.id === id, ...await getCommandWorkflow(env, owner, admitted.id, now) };
}

export async function getCommandWorkflow(env: Env, owner: string, id: string, now = Date.now()) {
  if (!JOB_ID.test(id)) throw new ReaderError("invalid_workflow_id", 400);
  const row = await byId(env, id);
  if (!row || row.owner_sub !== owner) throw new ReaderError("not_found", 404);
  const plan = snapshots(row), jobs = [];
  for (let index = 0; index < plan.length; index++) {
    const step = plan[index];
    if (index > row.current_index) { jobs.push({ template: step.template, status: "not_started", job_id: null, expected_steps: step.steps.length }); continue; }
    const result = await getReaderJob(env, step.job_id, now);
    jobs.push({ ...result.job, job_id: step.job_id, availability: result.availability, result_set_complete: result.result_set_complete,
      missing_step_indices: result.missing_step_indices, fetch_tool: "get_command_result_job", arguments: { job_id: step.job_id } });
  }
  const current = await env.DB.prepare("SELECT status,lease_expires_at FROM command_jobs WHERE id=?").bind(row.current_job_id)
    .first<{ status: string; lease_expires_at: string | null }>();
  const stalled = row.status === "running" && (sqlTime(now) >= row.deadline_at ||
    (current?.status === "queued" && sqlTime(now) >= row.start_before) ||
    (current?.status === "leased" && (!current.lease_expires_at || current.lease_expires_at <= sqlTime(now))));
  const heartbeat = await env.DB.prepare("SELECT value FROM system_state WHERE key='command_agent_last_seen'").first<{ value: string }>();
  const lastSeen = utcTimestamp(heartbeat?.value ?? null), age = lastSeen ? Math.max(0, Math.floor((now - Date.parse(lastSeen)) / 1000)) : null;
  return {
    schema_version: 1, workflow_id: row.id, mode: row.mode, status: row.status, error: row.error,
    requested_at: utcTimestamp(row.requested_at), accepted_at: utcTimestamp(row.accepted_at),
    deadline_at: utcTimestamp(row.deadline_at), finished_at: utcTimestamp(row.finished_at), read_at: new Date(now).toISOString(),
    current_job_id: row.current_job_id, current_index: row.current_index, jobs,
    requires_attention: row.status === "needs_attention" || stalled,
    global_lock_held: ["running", "needs_attention"].includes(row.status),
    observation: stalled ? current?.status === "queued" ? "agent_queue_start_window_elapsed" : "execution_timeout_uncertain" : row.status,
    next_poll_after_seconds: row.status === "running" && !stalled ? 15 : null,
    agent: { last_seen_at: lastSeen, heartbeat_age_seconds: age, online_hint: age !== null && age <= 60 ? "recent_queue_contact" : "unknown_or_stale",
      execution_dependency: "configured Telegram session agent host; heartbeat does not prove Telegram readiness" },
    source_data_at: null, source_time_status: "unknown", source_freshness: "unknown",
    draft_evidence_state: "requires_content_review",
    evidence_note: "Only the job IDs in this workflow belong to this request. Read each exact job and its media; never substitute latest history. No silent command retry. Stalled leases keep the global lock until the original job is terminal.",
  };
}

async function finish(env: Env, row: Workflow, status: string, error: string | null, now: number) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE command_workflows SET status=?,error=?,finished_at=? WHERE id=? AND current_job_id=? AND status IN ('running','needs_attention')`)
      .bind(status, error, sqlTime(now), row.id, row.current_job_id),
    env.DB.prepare(`DELETE FROM system_state WHERE key=? AND value=? AND EXISTS
      (SELECT 1 FROM command_workflows WHERE id=? AND status NOT IN ('running','needs_attention'))`).bind(WORKFLOW_LOCK, row.id, row.id),
  ]);
}

// Agent hooks advance the durable workflow; read/status tools never mutate it.
// A lock is checked even if new runs are disabled, so disabling the flag cannot mix jobs.
export async function refreshActiveWorkflow(env: Env, now = Date.now()): Promise<string | null> {
  const lock = await env.DB.prepare("SELECT value FROM system_state WHERE key=?").bind(WORKFLOW_LOCK).first<{ value: string }>();
  if (!lock) return null;
  const row = await byId(env, lock.value);
  if (!row || !["running", "needs_attention"].includes(row.status)) throw new Error("workflow_lock_inconsistent");
  const job = await env.DB.prepare("SELECT status,lease_expires_at FROM command_jobs WHERE id=?").bind(row.current_job_id)
    .first<{ status: string; lease_expires_at: string | null }>();
  if (!job) throw new Error("workflow_job_missing");
  const at = sqlTime(now), deadline = at >= row.deadline_at;
  if (!terminal.has(job.status)) {
    if (job.status === "queued" && (deadline || at >= row.start_before)) {
      // Atomic CAS: if the agent acquired a lease concurrently, do not cancel it or release the lock.
      await env.DB.batch([
        env.DB.prepare("UPDATE command_jobs SET status='cancelled',finished_at=?,error='workflow_start_timeout' WHERE id=? AND status='queued'")
          .bind(at, row.current_job_id),
        env.DB.prepare(`UPDATE command_workflows SET status='timed_out',error='agent_queue_timeout',finished_at=?
          WHERE id=? AND current_job_id=? AND EXISTS (SELECT 1 FROM command_jobs WHERE id=? AND status='cancelled')`)
          .bind(at, row.id, row.current_job_id, row.current_job_id),
        env.DB.prepare(`DELETE FROM system_state WHERE key=? AND value=? AND EXISTS (SELECT 1 FROM command_workflows WHERE id=? AND status='timed_out')`)
          .bind(WORKFLOW_LOCK, row.id, row.id),
      ]);
    } else if (job.status === "leased" && (deadline || !job.lease_expires_at || job.lease_expires_at <= at)) {
      await env.DB.prepare(`UPDATE command_workflows SET status='needs_attention',error=? WHERE id=? AND current_job_id=? AND status='running'`)
        .bind(deadline ? "workflow_deadline_execution_uncertain" : "agent_lease_expired_execution_uncertain", row.id, row.current_job_id).run();
    }
  } else if (row.status === "needs_attention" || deadline) {
    await finish(env, row, "timed_out", "execution_returned_after_timeout_no_next_job", now);
  } else if (job.status !== "completed") {
    await finish(env, row, "failed", "job_" + job.status, now);
  } else {
    const result = await getReaderJob(env, row.current_job_id, now);
    if (!result.result_set_complete) await finish(env, row, "partial", "result_set_incomplete_no_next_job", now);
    else {
      const plan = snapshots(row), next = plan[row.current_index + 1];
      if (!next) await finish(env, row, "completed", null, now);
      else await env.DB.batch([
        env.DB.prepare(`UPDATE command_workflows SET current_index=current_index+1,current_job_id=?,start_before=?
          WHERE id=? AND current_index=? AND current_job_id=? AND status='running'
          AND EXISTS (SELECT 1 FROM command_jobs WHERE id=? AND status='completed')`)
          .bind(next.job_id, sqlTime(now + 10 * 60_000), row.id, row.current_index, row.current_job_id, row.current_job_id),
        insertJob(env, row, next, row.current_index + 1, at),
      ]);
    }
  }
  return (await env.DB.prepare("SELECT value FROM system_state WHERE key=?").bind(WORKFLOW_LOCK).first<{ value: string }>())?.value ?? null;
}

export async function claimCommandJob(env: Env, token: string, expiry: string, now = Date.now()) {
  const workflowId = await refreshActiveWorkflow(env, now), at = sqlTime(now);
  // The final atomic UPDATE rechecks the durable lock. A concurrent workflow start
  // cannot be bypassed by a caller that observed no lock a moment earlier.
  const candidate = workflowId
    ? `status='queued' AND id=(SELECT current_job_id FROM command_workflows WHERE id=? AND status='running')`
    : `(status='queued' OR (status='leased' AND lease_expires_at<?))`;
  const args = workflowId ? [workflowId] : [at];
  const lockGuard = workflowId
    ? `EXISTS (SELECT 1 FROM system_state WHERE key=? AND value=?)`
    : `NOT EXISTS (SELECT 1 FROM system_state WHERE key=?)`;
  const lockArgs = workflowId ? [WORKFLOW_LOCK, workflowId] : [WORKFLOW_LOCK];
  const leaseGuard = workflowId ? "other.status='leased'" : "other.status='leased' AND (other.lease_expires_at IS NULL OR other.lease_expires_at>=?)";
  const leaseArgs = workflowId ? [] : [at];
  return env.DB.prepare(`UPDATE command_jobs SET status='leased',lease_token=?,lease_expires_at=?,attempts=attempts+1,
    started_at=COALESCE(started_at,?),error=NULL WHERE id=(SELECT id FROM command_jobs WHERE ${candidate}
    AND ${lockGuard}
    AND NOT EXISTS (SELECT 1 FROM command_jobs other WHERE ${leaseGuard})
    ORDER BY created_at,id LIMIT 1)
    RETURNING id,name,steps_json,status,lease_token,lease_expires_at,attempts,error,created_at,started_at,finished_at`)
    .bind(token, expiry, at, ...args, ...lockArgs, ...leaseArgs).first();
}
