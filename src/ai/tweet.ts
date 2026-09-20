import type { Env, FeedItem } from "../types";
import { fetchSourceBundle } from "./content";
import { sha256 } from "../utils/text";

import { SYSTEM_PROMPT, PROMPT_VERSION, formatDraft } from "./prompt";

const MODEL = "gpt-5.6-luna";
interface OpenAIResponse {
  status?: string;
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

function responseText(response: OpenAIResponse): string {
  const direct = response.output_text?.trim();
  if (direct) return direct;
  return (response.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === "output_text" && part.text).map(part => part.text!.trim()).join("\n").trim();
}

export async function generateTweetDraft(env: Env, item: FeedItem): Promise<{ tweet: string; cached: boolean }> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY yapılandırılmamış");
  const cacheModel = `${MODEL}:${PROMPT_VERSION}`;
  const cached = await env.DB.prepare("SELECT tweet_text FROM ai_tweet_drafts WHERE feed_item_id=? AND model=?").bind(item.id, cacheModel).first<{ tweet_text: string }>();
  if (cached?.tweet_text) return { tweet: cached.tweet_text, cached: true };
  const source = await fetchSourceBundle(item);
  const symbols = JSON.parse(item.tickers_json ?? "[]") as string[];
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: JSON.stringify({ target: { title: item.title, type: item.type, publishedAt: item.published_at, url: item.url }, sourceText: source.text, verifiedSymbols: symbols }) }];
  for (const attachment of source.attachments) {
    // External file inputs accept the URL (and optional PDF detail); the local
    // filename is retained only for discovery/debugging and is not sent.
    content.push({ type: "input_file", file_url: attachment.url, ...(attachment.isPdf ? { detail: "high" } : {}) });
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(100_000),
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, instructions: SYSTEM_PROMPT, input: [{ role: "user", content }], reasoning: { effort: "low" }, text: { verbosity: "low" }, max_output_tokens: 900, store: false }),
  });
  const result = await response.json<OpenAIResponse>();
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  if (result.status && result.status !== "completed") throw new Error("OpenAI yanıtı tamamlanmadı; eksik taslak kullanılmadı");
  const tweet = formatDraft(responseText(result), symbols, item.url);
  if (!tweet) throw new Error("OpenAI boş tweet döndürdü");
  const digest = await sha256(`${item.source_ref}\n${source.text}\n${source.attachments.map(file => file.url).join("\n")}`);
  await env.DB.prepare("INSERT OR REPLACE INTO ai_tweet_drafts(feed_item_id,tweet_text,model,source_digest,created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)").bind(item.id, tweet, cacheModel, digest).run();
  return { tweet, cached: false };
}
