export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  MKK_API_KEY?: string;
  MKK_API_SECRET?: string;
  MKK_API_BASE_URL?: string;
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
  published_at: string | null;
  created_at: string;
}

