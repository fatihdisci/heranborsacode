-- Existing finance records keep category NULL and are invisible to the AI API.
ALTER TABLE feed_items ADD COLUMN category TEXT;
ALTER TABLE feed_items ADD COLUMN priority TEXT;
ALTER TABLE feed_items ADD COLUMN metadata_json TEXT;
CREATE INDEX IF NOT EXISTS idx_feed_ai_category ON feed_items(category, published_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS ai_source_items (
  source_ref TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(normalized_url),
  UNIQUE(content_hash)
);
CREATE INDEX IF NOT EXISTS idx_ai_source_items_source ON ai_source_items(source_id, created_at DESC);
-- Retain historical delivery records while stopping pre-transition finance work.
UPDATE telegram_outbox SET status='superseded',lease_until=0
WHERE status IN ('pending','sending','buffered','blocked')
  AND (source_ref LIKE 'kap:%' OR source_ref LIKE 'spk:%' OR source_ref LIKE 'rss:%' OR id LIKE 'dkb:%');
UPDATE telegram_actions SET status='failed',lease_until=0
WHERE status IN ('queued','processing') AND feed_item_id IN (SELECT id FROM feed_items WHERE category IS NULL);
UPDATE telegram_outbox SET status='superseded',lease_until=0
WHERE status IN ('pending','sending','blocked') AND id IN
  (SELECT 'action:' || id FROM telegram_actions WHERE feed_item_id IN (SELECT id FROM feed_items WHERE category IS NULL));
UPDATE operational_incidents SET resolved_at=CURRENT_TIMESTAMP
WHERE resolved_at IS NULL AND (id LIKE 'rss:%' OR id LIKE 'kap:%' OR id='spk');

UPDATE telegram_outbox SET status='superseded',lease_until=0
WHERE status IN ('pending','sending','blocked') AND (id LIKE 'alert:rss:%' OR id LIKE 'alert:kap:%' OR id LIKE 'alert:spk:%' OR id LIKE 'recovery:rss:%' OR id LIKE 'recovery:kap:%' OR id LIKE 'recovery:spk:%');
