-- Retain the source citations and numeric bindings behind the latest ordinary
-- draft for diagnosis. Prompt-versioned caching excludes older unchecked rows.
ALTER TABLE ai_tweet_drafts ADD COLUMN evidence_json TEXT;
