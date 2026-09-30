-- Extend only the mode CHECK; preserve every existing workflow row and lock index.
-- Apply through the official transactional D1 migration runner.
CREATE TABLE command_workflows_extended (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  request_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('market_round','terane','kurum','sonhalkaarzlar','genelkurum')),
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
INSERT INTO command_workflows_extended (id,owner_sub,request_key,mode,status,snapshots_json,current_index,current_job_id,requested_at,accepted_at,start_before,deadline_at,finished_at,error) SELECT id,owner_sub,request_key,mode,status,snapshots_json,current_index,current_job_id,requested_at,accepted_at,start_before,deadline_at,finished_at,error FROM command_workflows;
DROP TABLE command_workflows;
ALTER TABLE command_workflows_extended RENAME TO command_workflows;
-- One active workflow globally implies one active workflow per user too.
CREATE UNIQUE INDEX command_workflow_active_lock ON command_workflows((1))
  WHERE status IN ('running','needs_attention');
CREATE INDEX command_workflow_job_idx ON command_workflows(current_job_id);
