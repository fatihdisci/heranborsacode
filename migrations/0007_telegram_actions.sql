CREATE TABLE telegram_actions (
  id TEXT PRIMARY KEY,
  callback_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  feed_item_id INTEGER NOT NULL,
  reply_to INTEGER NOT NULL,
  page_ref TEXT,
  page_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  result_text TEXT
);
CREATE INDEX idx_actions_status ON telegram_actions(status,created_at);
CREATE INDEX idx_actions_item ON telegram_actions(feed_item_id,action,created_at);
CREATE INDEX idx_actions_created ON telegram_actions(created_at);
