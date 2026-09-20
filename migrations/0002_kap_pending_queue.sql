CREATE TABLE IF NOT EXISTS kap_pending (disclosure_index TEXT PRIMARY KEY, disclosure_type TEXT, disclosure_class TEXT, title TEXT, queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_kap_pending_queued_at ON kap_pending(queued_at);
