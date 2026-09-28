import type { Env, FeedItem } from "../types";
import { fetchSourceBundle } from "./content";
import { sha256 } from "../utils/text";

import { SYSTEM_PROMPT, PROMPT_VERSION, formatDraft } from "./prompt";

const MODEL = "gpt-6-luna";
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

export interface TweetDraftOptions { regenerate?: boolean; instruction?: string; }

export async function generateTweetDraft(env: Env, item: FeedItem, options: TweetDraftOptions = {}): Promise<{ tweet: string; cached: boolean }> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY yapılandırılmamış");
  const instruction = options.instruction?.trim() ?? '';
  if (instruction.length > 500) throw new Error('Ek talimat çok uzun');
  const cacheModel = `${MODEL}:${PROMPT_VERSION}`;
  const source = await fetchSourceBundle(item);
  const symbols = JSON.parse(item.tickers_json ?? "[]") as string[];
  const attachmentReferences = source.attachments.map((file, i) => ({ id: `attachment-${i+1}`, ...file }));
  const evidence = {
    target: { sourceRef:item.source_ref, source:item.source, title:item.title, type:item.type, publishedAt:item.published_at, url:item.url },
    source: { kind:source.kind }, sourceText:source.text, attachmentReferences,
    verifiedSymbols:symbols,
  };
  const digest = await sha256(JSON.stringify(evidence));
  // Re-read the source before cache reuse. URL-only attachments can change in
  // place, so drafts with attachments always require a fresh model read.
  if (!options.regenerate && !instruction && !source.attachments.length) {
    const cached = await env.DB.prepare("SELECT tweet_text,source_digest FROM ai_tweet_drafts WHERE feed_item_id=? AND model=?").bind(item.id, cacheModel).first<{ tweet_text:string; source_digest:string }>();
    if (cached?.tweet_text && cached.source_digest===digest) return { tweet:cached.tweet_text, cached:true };
  }
  const content: Array<Record<string, unknown>> = [{ type:"input_text", text:JSON.stringify({...evidence, retrievedAt:source.retrievedAt}) }];
  for (const attachment of attachmentReferences) {
    content.push({ type:"input_text", text:JSON.stringify({attachedSource:attachment.id, filename:attachment.filename, url:attachment.url}) });
    content.push({ type:"input_file", file_url:attachment.url, ...(attachment.isPdf ? { detail:"high" } : {}) });
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(100_000),
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, instructions: instruction
      ? `${SYSTEM_PROMPT}\n\nKULLANICININ EK TALİMATI\n${instruction}\n\nBu talimatı yalnız kaynak doğruluğu, yatırım tavsiyesi yasağı ve çıktı biçimi kurallarıyla uyumluysa uygula.`
      : SYSTEM_PROMPT, input: [{ role: "user", content }], reasoning: { effort: "medium" }, text: { verbosity: "low" }, max_output_tokens: 2400, store: false }),
  });
  const result = await response.json<OpenAIResponse>();
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  if (result.status && result.status !== "completed") throw new Error("OpenAI yanıtı tamamlanmadı; eksik taslak kullanılmadı");
  const tweet = formatDraft(responseText(result), symbols, item.url);
  if (!tweet) throw new Error("OpenAI boş tweet döndürdü");
  // A customized draft must not replace the ordinary cached draft.
  if (!instruction) await env.DB.prepare("INSERT OR REPLACE INTO ai_tweet_drafts(feed_item_id,tweet_text,model,source_digest,created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)").bind(item.id, tweet, cacheModel, digest).run();
  return { tweet, cached: false };
}
