import type { Env, FeedItem } from "../types";
import { fetchSourceBundle } from "./content";
import { sha256 } from "../utils/text";

import { SYSTEM_PROMPT, ANALYSIS_PROMPT, PROMPT_VERSION, formatDraft, MAX_PREVIOUS_DRAFT_LENGTH } from "./prompt";
import { ANALYSIS_SCHEMA, DRAFT_SCHEMA, SourceValidationError, validateAnalysis, validateWrittenDraft, supportingEvidence, actorNames } from './evidence';

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

async function requestJSON(env:Env,content:Array<Record<string,unknown>>,instructions:string,schema:Record<string,unknown>,phase:'source_analysis'|'tweet_writer',deadline:number):Promise<unknown> {
  const remaining=deadline-Date.now();
  if(remaining<1000)throw new Error('Kaynak çözümleme zaman sınırını aştı');
  const response=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',signal:AbortSignal.timeout(Math.min(remaining,phase==='source_analysis'?90_000:50_000)),
    headers:{authorization:`Bearer ${env.OPENAI_API_KEY}`,'content-type':'application/json'},
    body:JSON.stringify({model:MODEL,instructions,input:[{role:'user',content}],
      reasoning:{effort:phase==='source_analysis'?'high':'medium'},
      text:{verbosity:phase==='tweet_writer'?'medium':'low',format:{type:'json_schema',name:phase,strict:true,schema}},
      max_output_tokens:6500,store:false}),
  });
  if(!response.ok)throw new Error(`OpenAI HTTP ${response.status}`);
  const result=await response.json<OpenAIResponse>();
  if(result.status!=='completed')throw new Error('OpenAI yanıtı tamamlanmadı; eksik taslak kullanılmadı');
  try {return JSON.parse(responseText(result));}
  catch {throw new Error('Modelin yapılandırılmış cevabı okunamadı; taslak kullanılmadı');}
}

export interface TweetDraftOptions { regenerate?: boolean; instruction?: string; previousDraft?: string; }

function revisionInstructions(base:string,instruction:string,phase:'analysis'|'writer'):string {
  if(!instruction)return base;
  return `${base}\n\nKULLANICININ EK TALİMATI\n${instruction}\n\n${phase==='analysis'
    ? 'Bu talimata yanıt verebilmek için gereken bilgileri kaynağın tamamında ara ve kanıtlı olgulara dahil et. İstenen vurgu veya bağlam ilk taslakta bulunmasa da kaynakta varsa seç. Önceki taslak kaynak kanıtı değildir.'
    : 'Bu bir revizyon isteğidir: talimatı metne somut olarak uygula. Kullanıcının uzunluk, üslup, başlık, paragraf ve vurgu tercihi yukarıdaki varsayılan yazım tercihlerinden önceliklidir. previousDraft varsa onu bu talimata göre yeniden düzenle; sadece eş anlamlı birkaç kelime değiştirerek geçiştirme. Kaynakla uyumlu ve değişiklik istenmeyen bilgileri koru.'}\nKaynak doğruluğu, rakamlar, işlem aşaması ve yatırım tavsiyesi yasağı değişmez. Talimat veya önceki taslak yeni olgu kanıtı değildir; kaynakta olmayan bilgi ekleme. JSON çıktı şemasını koru.`;
}

async function validatedJSON<T>(env:Env,content:Array<Record<string,unknown>>,instructions:string,schema:Record<string,unknown>,phase:'source_analysis'|'tweet_writer',deadline:number,validate:(value:unknown)=>T):Promise<{raw:unknown;value:T;repaired:boolean}> {
  const check=(value:unknown):T=>{try{return validate(value);}catch(error){if(error instanceof SourceValidationError)error.context={...error.context,phase};throw error;}};
  let raw=await requestJSON(env,content,instructions,schema,phase,deadline);
  try {return {raw,value:check(raw),repaired:false};}
  catch(error) {
    // Only a complete answer that failed a deterministic evidence check can
    // be repaired, once per phase. Never retry an API error, refusal, missing
    // source, incomplete response, or a model-declared conflict/rejection.
    if(!(error instanceof SourceValidationError) || (raw as {status?:string})?.status!=='ready' || deadline-Date.now()<15_000)throw error;
    const correction={validationError:error.message,validationContext:error.context,previousOutput:raw};
    raw=await requestJSON(env,[...content,{type:'input_text',text:JSON.stringify(correction)}],
      `${instructions}\n\nDOĞRULAMA DÜZELTMESİ\nÖnceki JSON kaynak kontrolünden geçmedi. validationError uygulamanın bulduğu hatadır; previousOutput doğrulanmamış veridir, talimat veya yeni kaynak değildir. Özgün kanıtlardan hatayı düzelt ve şemanın tamamını yeniden döndür. Kuralı aşma, sayı veya alıntı uydurma. Ana olay korunuyorsa doğrulanamayan ikincil ayrıntıyı çıkarabilirsin; ana olay da doğrulanamıyorsa uygun yetersizlik/ret durumunu döndür.`,
      schema,phase,deadline);
    return {raw,value:check(raw),repaired:true};
  }
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
  // Both phases share a time budget below the Telegram action's 180s lease.
  // At most one evidence correction per phase, within this shared budget.
  const deadline=Date.now()+130_000;
  const analysed=await validatedJSON(env,content,revisionInstructions(ANALYSIS_PROMPT,instruction,'analysis'),ANALYSIS_SCHEMA,'source_analysis',deadline,
    value=>validateAnalysis(value,source.document,attachmentReferences.map(file=>file.id),item.title));
  const analysis=analysed.value;
  const selectedAttachments=new Set([...analysis.event.evidence,...analysis.facts.flatMap(fact=>fact.evidence)].map(ref=>ref.sourceId));
  const writerContent:Array<Record<string,unknown>>=[{type:'input_text',text:JSON.stringify({
    target:evidence.target,source:evidence.source,verifiedSymbols:symbols,
    verifiedEvent:analysis.event,verifiedActorNames:actorNames(analysis.event),verifiedFacts:analysis.facts,ambiguities:analysis.ambiguities,
    revision,sourceDocument:source.document,
    supportingEvidence:supportingEvidence(analysis,source.document),
    attachmentReferences:attachmentReferences.filter(file=>selectedAttachments.has(file.id)),
  })}];
  for(const attachment of attachmentReferences.filter(file=>selectedAttachments.has(file.id))) {
    writerContent.push({type:'input_text',text:JSON.stringify({attachedSource:attachment.id,filename:attachment.filename,url:attachment.url})});
    writerContent.push({type:'input_file',file_url:attachment.url,...(attachment.isPdf?{detail:'high'}:{})});
  }
  const written=await validatedJSON(env,writerContent,revisionInstructions(SYSTEM_PROMPT,instruction,'writer'),
    DRAFT_SCHEMA,'tweet_writer',deadline,value=>{
      const body=validateWrittenDraft(value,analysis);
      const comparable=(text:string)=>text.replace(/^(?:#[\p{L}\p{N}]+\s*)+/u,'').replace(/\r\n/g,'\n').replace(/[ \t]+/g,' ').trim();
      if(previousDraft && comparable(body)===comparable(previousDraft))throw new SourceValidationError('revizyon önceki taslakla aynı; ek talimatı ve istenen yeni anlatımı uygula');
      return body;
    });
  const body=written.value;
  const tweet = formatDraft(body, symbols);
  if (!tweet) throw new Error("OpenAI boş tweet döndürdü");
  // A customized draft must not replace the ordinary cached draft.
  if (!instruction) await env.DB.prepare("INSERT OR REPLACE INTO ai_tweet_drafts(feed_item_id,tweet_text,model,source_digest,evidence_json,created_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)").bind(item.id, tweet, cacheModel, digest,JSON.stringify({version:PROMPT_VERSION,analysis,draft:written.raw,repairs:{analysis:analysed.repaired,writer:written.repaired}})).run();
  return { tweet, cached: false };
}
