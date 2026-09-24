import type { Env, FeedItem } from "../types";
import { fetchSourceBundle } from "./content";
import { sha256 } from "../utils/text";

import { SYSTEM_PROMPT, PROMPT_VERSION, formatDraft } from "./prompt";
import { MODEL, generateAIText } from './openai';

export interface DraftOptions { language: 'tr'; tone: 'natural' | 'news' | 'commentary'; note: string; }
const DEFAULT_OPTIONS: DraftOptions = {language:'tr',tone:'natural',note:''};
export async function generateTweetDraft(env: Env, item: FeedItem, options: DraftOptions = DEFAULT_OPTIONS): Promise<{ tweet: string; cached: boolean }> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY yapılandırılmamış");
  const cacheModel = `${MODEL}:${PROMPT_VERSION}`;
  const cacheable = options.language === 'tr' && options.tone === 'natural' && !options.note.trim();
  const cached = cacheable ? await env.DB.prepare("SELECT tweet_text FROM ai_tweet_drafts WHERE feed_item_id=? AND model=?").bind(item.id, cacheModel).first<{ tweet_text: string }>() : null;
  if (cached?.tweet_text) return { tweet: cached.tweet_text, cached: true };
  const source = await fetchSourceBundle(item);
  const attachments: Array<Record<string, unknown>> = [];
  for (const attachment of source.attachments) {
    // External file inputs accept the URL (and optional PDF detail); the local
    // filename is retained only for discovery/debugging and is not sent.
    attachments.push({ type: "input_file", file_url: attachment.url, ...(attachment.isPdf ? { detail: "high" } : {}) });
  }
  const raw=await generateAIText(env,SYSTEM_PROMPT,{target:{title:item.title,category:item.category,publishedAt:item.published_at,url:item.url},sourceText:source.text,userNote:options.note.trim(),language:options.language,tone:options.tone},attachments);
  const tweet = formatDraft(raw, item.url,Boolean(options.note.trim()));
  if (!tweet) throw new Error("OpenAI boş tweet döndürdü");
  const digest = await sha256(`${item.source_ref}\n${source.text}\n${source.attachments.map(file => file.url).join("\n")}`);
  if (cacheable) await env.DB.prepare("INSERT OR REPLACE INTO ai_tweet_drafts(feed_item_id,tweet_text,model,source_digest,created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)").bind(item.id, tweet, cacheModel, digest).run();
  return { tweet, cached: false };
}
