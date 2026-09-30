-- Preserve command_results text and media references; record expiry separately.
CREATE TABLE command_media_expirations (
  media_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_trt_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','deleted','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL,
  planned_at TEXT NOT NULL,
  deleted_at TEXT,
  error TEXT
);
CREATE INDEX command_media_expirations_job ON command_media_expirations(job_id,status);
