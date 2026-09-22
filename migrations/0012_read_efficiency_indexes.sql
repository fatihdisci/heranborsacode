-- Match the expressions and filters used by the two highest-volume ordered
-- reads. These indexes change query plans only; application behavior is
-- unchanged.
CREATE INDEX IF NOT EXISTS idx_feed_effective_timeline
  ON feed_items(COALESCE(published_at, created_at) DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_sent_seen
  ON telegram_outbox(status, first_seen_at DESC)
  WHERE source_ref IS NOT NULL;
