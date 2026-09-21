CREATE TABLE IF NOT EXISTS command_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS command_jobs (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','completed','failed','cancelled')),
  lease_token TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  notified_at TEXT,
  FOREIGN KEY(template_id) REFERENCES command_templates(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS command_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  bot_username TEXT NOT NULL,
  command TEXT NOT NULL,
  response_text TEXT NOT NULL DEFAULT '',
  response_kind TEXT NOT NULL DEFAULT 'text' CHECK(response_kind IN ('text','image','file')),
  media_key TEXT,
  file_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES command_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS command_jobs_claim_idx ON command_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS command_results_job_idx ON command_results(job_id, step_index, id);
