export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  POLL_SHARDS: DurableObjectNamespace;
  TELEGRAM_ACTIONS: DurableObjectNamespace;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  EVENING_SUMMARY_ENABLED?: string;
  EVENING_SUMMARY_CALENDAR_JSON?: string;
  TELEGRAM_ALLOWED_USERNAME?: string;
  COMMAND_AGENT_TOKEN?: string;
  // Separate, disabled-by-default OAuth resource for reading stored results.
  RESULTS_READ_ENABLED?: string;
  COMMAND_RUN_ENABLED?: string;
  COMMAND_MEDIA_RETENTION_MODE?: 'off' | 'dry_run' | 'delete';
  RESULTS_OAUTH_ISSUER?: string;
  RESULTS_OAUTH_JWKS_URL?: string;
  RESULTS_OAUTH_SUBJECT?: string;
  SAFARI_EXTENSION_TOKEN?: string;
  COMMAND_MEDIA: R2Bucket;
  MKK_API_KEY?: string;
  MKK_API_SECRET?: string;
  MKK_API_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  PUBLIC_BASE_URL?: string;
  X_NITTER_BASE_URL?: string;
}

export type FeedType = "kap" | "spk" | "news";

export interface FeedItem {
  id: number;
  type: FeedType;
  source: string;
  source_ref: string;
  title: string;
  body: string | null;
  url: string;
  tickers_json: string | null;
  subject_tickers_json?: string | null;
  published_at: string | null;
  created_at: string;
}
