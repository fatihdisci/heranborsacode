CREATE TABLE telegram_outbox (
  id TEXT PRIMARY KEY,
  source_ref TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  group_id TEXT,
  first_seen_at TEXT NOT NULL,
  published_at TEXT,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  message_id INTEGER,
  last_error TEXT
);
CREATE INDEX idx_outbox_ready ON telegram_outbox(status, available_at);
CREATE INDEX idx_outbox_group ON telegram_outbox(group_id);
CREATE INDEX idx_outbox_seen ON telegram_outbox(first_seen_at);
CREATE INDEX idx_outbox_source ON telegram_outbox(source_ref);
CREATE TABLE operational_incidents (
  id TEXT PRIMARY KEY,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  detail TEXT NOT NULL
);
-- Heal source rows committed by the old poller before feed insertion failed.
INSERT OR IGNORE INTO feed_items(type,source,source_ref,title,body,url,tickers_json,published_at,created_at)
SELECT 'kap','KAP','kap:'||disclosure_id,title,company,url,
  CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.codes')='array' THEN json_extract(metadata_json,'$.codes')
    WHEN length(ticker) BETWEEN 4 AND 5 THEN json_array(ticker) ELSE '[]' END,
  published_at,created_at FROM kap_disclosures WHERE telegram_status='pending';
INSERT OR IGNORE INTO feed_items(type,source,source_ref,title,body,url,tickers_json,published_at,created_at)
SELECT 'news',source,'rss:'||content_hash,title,NULL,url,tickers_json,published_at,fetched_at FROM rss_items WHERE telegram_status='pending';
INSERT OR IGNORE INTO feed_items(type,source,source_ref,title,body,url,tickers_json,published_at,created_at)
SELECT 'spk','SPK','spk:'||bulletin_number,'SPK Bülteni: '||bulletin_number,bulletin_date,pdf_url,'[]',NULL,first_seen_at
FROM spk_bulletins WHERE telegram_status='pending';
-- Recover previously pending records only; sent/baseline records never replay.
INSERT OR IGNORE INTO telegram_outbox(id,source_ref,kind,payload,status,first_seen_at,published_at,available_at)
SELECT f.source_ref,f.source_ref,'message',
  json_object('text', f.title || char(10) || COALESCE(f.body,''), 'plain',json('true'), 'button',json_object('text','Kaynağı Aç','url',f.url)),
  'pending',f.created_at,f.published_at,unixepoch('now')*1000
FROM feed_items f
WHERE (EXISTS(SELECT 1 FROM rss_items r WHERE f.source_ref='rss:'||r.content_hash AND r.telegram_status='pending')
  OR EXISTS(SELECT 1 FROM kap_disclosures k WHERE f.source_ref='kap:'||k.disclosure_id AND k.telegram_status='pending')
  OR EXISTS(SELECT 1 FROM spk_bulletins s WHERE f.source_ref='spk:'||s.bulletin_number AND s.telegram_status='pending'))
  AND datetime(f.created_at)>=datetime('now','-1 day');
-- DKBs use the same deterministic format on recovery and on new intake.
UPDATE telegram_outbox SET kind='dkb',status='buffered',
  payload=json_object('codes',json(COALESCE((SELECT tickers_json FROM feed_items WHERE source_ref=telegram_outbox.source_ref),'[]')))
WHERE source_ref IN (SELECT source_ref FROM feed_items WHERE type='kap' AND (title LIKE '%Devre Kesici%' OR title LIKE '%DEVRE KESİCİ%'));
