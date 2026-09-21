ALTER TABLE command_jobs ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_command_jobs_request_key ON command_jobs(request_key) WHERE request_key IS NOT NULL;
