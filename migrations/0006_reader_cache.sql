CREATE TABLE IF NOT EXISTS reader_cache (
  feed_item_id INTEGER PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  payload TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
