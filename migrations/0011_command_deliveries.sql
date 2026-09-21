CREATE TABLE IF NOT EXISTS command_deliveries (
  job_id TEXT NOT NULL,
  part TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','sent','failed')),
  message_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(job_id,part),
  FOREIGN KEY(job_id) REFERENCES command_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_command_deliveries_retry ON command_deliveries(status,updated_at);
