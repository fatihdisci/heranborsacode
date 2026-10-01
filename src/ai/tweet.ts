import type { Env, FeedItem } from "../types";
import { fetchSourceBundle } from "./content";
import { sha256 } from "../utils/text";

import { SYSTEM_PROMPT, PROMPT_VERSION, formatDraft, MAX_PREVIOUS_DRAFT_LENGTH } from "./prompt";

const MODEL = "gpt-6-luna";
interface OpenAIResponse {
  status?: string;
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  error?: { message?: string };
}

function responseText(response: OpenAIResponse): string {
  if(response.output?.some(item=>item.content?.some(part=>part.type==='refusal' || part.refusal)))throw new Error('Model kaynak doğrulamasını tamamlayamadı');
  const direct = response.output_text?.trim();
  if (direct) return direct;
  return (response.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === "output_text" && part.text).map(part => part.text!.trim()).join("\n").trim();
}

const DRAFT_SCHEMA = {
  type:'object',additionalProperties:false,required:['status','body'],
  properties:{status:{type:'string',enum:['ready','insufficient']},body:{type:'string'}},
};

async function requestDraft(env:Env,content:Array<Record<string,unknown>>,instructions:string):Promise<string> {
  const response=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',signal:AbortSignal.timeout(100_000),
    headers:{authorization:`Bearer ${env.OPENAI_API_KEY}`,'content-type':'application/json'},
    body:JSON.stringify({model:MODEL,instructions,input:[{role:'user',content}],
      reasoning:{effort:'medium'},
      text:{verbosity:'medium',format:{type:'json_schema',name:'tweet_draft',strict:true,schema:DRAFT_SCHEMA}},
      max_output_tokens:8000,store:false}),
  });
  if(!response.ok)throw new Error(`OpenAI HTTP ${response.status}`);
  const result=await response.json<OpenAIResponse>();
  if(result.status!=='completed')throw new Error('OpenAI yanıtı tamamlanmadı; eksik taslak kullanılmadı');
  let draft:{status?:string;body?:unknown};
  try {draft=JSON.parse(responseText(result));}
  catch {throw new Error('Modelin yapılandırılmış cevabı okunamadı');}
  if(draft?.status==='insufficient')throw new Error('Kaynak ana gelişmeyi anlatmak için yeterli değil');
  if(draft?.status!=='ready' || typeof draft.body!=='string' || !draft.body.trim())throw new Error('OpenAI boş tweet döndürdü');
  return draft.body;
}

export interface TweetDraftOptions { regenerate?: boolean; instruction?: string; previousDraft?: string; }

function revisionInstructions(instruction:string):string {
  if(!instruction)return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n\nKULLANICININ EK TALİMATI\n${instruction}\n\nBu tercihi taslağa somut olarak uygula. Uzunluk, başlık, paragraf, üslup ve vurgu tercihleri varsayılan yazım tercihlerinden önceliklidir. revision.previousDraft varsa onu yeniden düzenle. İstenen ayrıntıyı kaynağın tamamında ara; önceki taslak veya talimat yeni bilgi kaynağı değildir. Kaynakta olmayan bilgi ekleme.`;
}

export async function generateTweetDraft(env: Env, item: FeedItem, options: TweetDraftOptions = {}): Promise<{ tweet: string; cached: boolean }> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY yapılandırılmamış");
  const instruction = options.instruction?.trim() ?? '';
  const previousDraft = options.previousDraft?.trim() ?? '';
  if (instruction.length > 500) throw new Error('Ek talimat çok uzun');
  if (previousDraft.length > MAX_PREVIOUS_DRAFT_LENGTH) throw new Error('Önceki taslak çok uzun');
  const cacheModel = `${MODEL}:${PROMPT_VERSION}`;
  const source = await fetchSourceBundle(item);
  const parsedSymbols:unknown=JSON.parse(item.subject_tickers_json ?? item.tickers_json ?? '[]');
  const symbols=Array.isArray(parsedSymbols)?parsedSymbols.filter((value):value is string=>typeof value==='string'):[];
  const attachmentReferences = source.attachments.map((file, i) => ({ id: `attachment-${i+1}`, ...file }));
  const evidence = {
    target: { sourceRef:item.source_ref, source:item.source, title:item.title, type:item.type, publishedAt:item.published_at, url:item.url },
    source: { kind:source.kind }, sourceText:source.text, sourceDocument:source.document, attachmentReferences,
    verifiedSymbols:symbols,
  };
  const digest = await sha256(JSON.stringify(evidence));
  // Re-read the source before cache reuse. URL-only attachments can change in
  // place, so drafts with attachments always require a fresh model read.
  if (!options.regenerate && !instruction && !previousDraft && !source.attachments.length) {
    const cached = await env.DB.prepare("SELECT tweet_text,source_digest FROM ai_tweet_drafts WHERE feed_item_id=? AND model=?").bind(item.id, cacheModel).first<{ tweet_text:string; source_digest:string }>();
    if (cached?.tweet_text && cached.source_digest===digest) return { tweet:cached.tweet_text, cached:true };
  }
  const revision={requested:Boolean(options.regenerate || instruction || previousDraft),instruction:instruction || null,previousDraft:previousDraft || null};
  const content: Array<Record<string, unknown>> = [{ type:"input_text", text:JSON.stringify({...evidence,revision,retrievedAt:source.retrievedAt}) }];
  for (const attachment of attachmentReferences) {
    content.push({ type:"input_text", text:JSON.stringify({attachedSource:attachment.id, filename:attachment.filename, url:attachment.url}) });
    content.push({ type:"input_file", file_url:attachment.url, ...(attachment.isPdf ? { detail:"high" } : {}) });
  }
  // One direct generation from the complete source. The editor reviews the
  // draft; no intermediate fact extraction, numeric gate or repair requests.
  const body=await requestDraft(env,content,revisionInstructions(instruction));
  const tweet = formatDraft(body, symbols);
  if (!tweet) throw new Error("OpenAI boş tweet döndürdü");
  // A customized draft must not replace the ordinary cached draft.
  if (!instruction) await env.DB.prepare("INSERT OR REPLACE INTO ai_tweet_drafts(feed_item_id,tweet_text,model,source_digest,evidence_json,created_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)").bind(item.id, tweet, cacheModel, digest,JSON.stringify({version:PROMPT_VERSION,mode:'direct',sourceKind:source.kind})).run();
  return { tweet, cached: false };
}
