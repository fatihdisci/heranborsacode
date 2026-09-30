-- Local preparation only: apply explicitly before enabling command runner.
CREATE TABLE command_workflows (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  request_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('market_round','terane','kurum','sonhalkaarzlar')),
  status TEXT NOT NULL CHECK(status IN ('running','needs_attention','completed','failed','partial','timed_out')),
  snapshots_json TEXT NOT NULL,
  current_index INTEGER NOT NULL DEFAULT 0,
  current_job_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  start_before TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  UNIQUE(owner_sub,request_key)
);
-- One active workflow globally implies one active workflow per user too.
CREATE UNIQUE INDEX command_workflow_active_lock ON command_workflows((1))
  WHERE status IN ('running','needs_attention');
CREATE INDEX command_workflow_job_idx ON command_workflows(current_job_id);
