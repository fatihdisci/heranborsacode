CREATE TABLE IF NOT EXISTS ai_tweet_drafts (
  feed_item_id INTEGER PRIMARY KEY,
  tweet_text TEXT NOT NULL,
  model TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_item_id) REFERENCES feed_items(id) ON DELETE CASCADE
);
