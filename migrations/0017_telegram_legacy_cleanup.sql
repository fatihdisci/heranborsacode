-- One-time deletion ledger for known, previously sent finance bot messages.
-- Historical D1 content is preserved; only Telegram messages are targeted.
CREATE TABLE IF NOT EXISTS telegram_legacy_cleanup (
  message_id INTEGER PRIMARY KEY,
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','deleted','expired')),
  attempted_at TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO telegram_legacy_cleanup(message_id,sent_at)
SELECT message_id,sent_at FROM telegram_outbox
WHERE status='sent' AND message_id IS NOT NULL AND sent_at IS NOT NULL
  AND (source_ref LIKE 'kap:%' OR source_ref LIKE 'spk:%' OR source_ref LIKE 'rss:%' OR kind='dkb_group');
INSERT OR IGNORE INTO telegram_legacy_cleanup(message_id,sent_at)
SELECT q.message_id,q.sent_at FROM telegram_outbox q
JOIN telegram_actions a ON q.id='action:'||a.id
JOIN feed_items f ON f.id=a.feed_item_id
WHERE q.status='sent' AND q.message_id IS NOT NULL AND q.sent_at IS NOT NULL AND f.category IS NULL;
INSERT OR IGNORE INTO telegram_legacy_cleanup(message_id,sent_at)
SELECT message_id,REPLACE(updated_at,' ','T')||'Z' FROM command_deliveries
WHERE status='sent' AND message_id IS NOT NULL;
UPDATE telegram_legacy_cleanup SET status='expired'
WHERE julianday(sent_at)<julianday('now','-47 hours');
CREATE INDEX IF NOT EXISTS idx_telegram_legacy_cleanup_status ON telegram_legacy_cleanup(status,sent_at DESC);
