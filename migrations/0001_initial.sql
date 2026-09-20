CREATE TABLE IF NOT EXISTS kap_disclosures (
  disclosure_id TEXT PRIMARY KEY,
  company TEXT,
  ticker TEXT,
  title TEXT NOT NULL,
  disclosure_type TEXT,
  published_at TEXT,
  url TEXT NOT NULL,
  metadata_json TEXT,
  content_hash TEXT NOT NULL,
  telegram_status TEXT NOT NULL DEFAULT 'pending',
  telegram_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kap_published_at ON kap_disclosures(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_kap_ticker ON kap_disclosures(ticker);

CREATE TABLE IF NOT EXISTS rss_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  content_hash TEXT NOT NULL,
  tickers_json TEXT,
  telegram_status TEXT NOT NULL DEFAULT 'pending',
  telegram_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(normalized_url),
  UNIQUE(content_hash)
);
CREATE INDEX IF NOT EXISTS idx_rss_published_at ON rss_items(published_at DESC);

CREATE TABLE IF NOT EXISTS spk_bulletins (
  bulletin_number TEXT PRIMARY KEY,
  bulletin_date TEXT,
  pdf_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  telegram_status TEXT NOT NULL DEFAULT 'baseline',
  telegram_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_spk_date ON spk_bulletins(bulletin_date DESC);

CREATE TABLE IF NOT EXISTS feed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('kap', 'spk', 'news')),
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT NOT NULL,
  tickers_json TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_feed_timeline ON feed_items(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_feed_type ON feed_items(type, published_at DESC);

CREATE TABLE IF NOT EXISTS feed_sources (
  url TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_success_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
