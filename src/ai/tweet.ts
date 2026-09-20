import type { Env, FeedItem } from "../types";
import { fetchSourceBundle } from "./content";
import { sha256 } from "../utils/text";

const MODEL = "gpt-5.6-luna";

const SYSTEM_PROMPT = `Sen Heran Borsa için Türkçe finans haberleri ve resmî bildirimlerden yayıma hazır X gönderileri hazırlayan dikkatli bir editörsün.

Yalnızca kullanıcı mesajında ve ek dosyalarda verilen bilgilere dayan. Bilgi uydurma, tahminde bulunma, yatırım tavsiyesi verme ve kaynakta olmayan neden-sonuç ilişkisi kurma. Resmî bildirim ile haber arasında çelişki varsa resmî bildirimi esas al. İsimleri, şirketleri, hisse kodlarını, tarihleri, para birimlerini, oranları ve işlem yönlerini eksiksiz ve hatasız koru.

Çıktı kuralları:
- Yalnızca doğrudan kopyalanıp yayımlanabilecek tweet metnini döndür; açıklama, başlık etiketi, markdown veya kod bloğu ekleme.
- Doğal, akıcı ve anlaşılır Türkçe kullan. Haber dili robotik olmasın.
- En fazla 5 kısa cümle yaz. İlk cümlede en önemli gelişmeyi söyle; kritik sayı ve ayrıntıları sonraki cümlelerde ver.
- İlgi çekici ol ama sansasyon, abartı, clickbait ve kesin olmayan ifade kullanma.
- Yalnız kaynakta açıkça geçen hisse kodlarını en başta hashtag olarak yaz; en fazla 3 hashtag kullan.
- Kaynak bağlantısını son satırda “🔗 ” ile aynen ver.
- Ekler varsa tamamını ana kaynakla birlikte değerlendir; tweet için maddi önemi olan ayrıntıları seç.
- Yetersiz veya çelişkili veri varsa bunu gizleme; doğrulanamayan ayrıntıyı metne alma.`;

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

function responseText(response: OpenAIResponse): string {
  const direct = response.output_text?.trim();
  if (direct) return direct;
  return (response.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === "output_text" && part.text).map(part => part.text!.trim()).join("\n").trim();
}

function cleanDraft(value: string): string {
  return value.replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export async function generateTweetDraft(env: Env, item: FeedItem): Promise<{ tweet: string; cached: boolean }> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY yapılandırılmamış");
  const cached = await env.DB.prepare("SELECT tweet_text FROM ai_tweet_drafts WHERE feed_item_id=?").bind(item.id).first<{ tweet_text: string }>();
  if (cached?.tweet_text) return { tweet: cached.tweet_text, cached: true };
  const source = await fetchSourceBundle(item);
  const symbols = JSON.parse(item.tickers_json ?? "[]") as string[];
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: `${source.text}\n\nDoğrulanmış hisse kodları: ${symbols.join(", ") || "Yok"}\nBu kaynaktan yayıma hazır tweet taslağını oluştur.` }];
  for (const attachment of source.attachments) {
    content.push({ type: "input_file", file_url: attachment.url, filename: attachment.filename, ...(attachment.isPdf ? { detail: "high" } : {}) });
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, instructions: SYSTEM_PROMPT, input: [{ role: "user", content }], reasoning: { effort: "low" }, text: { verbosity: "low" }, max_output_tokens: 900, store: false }),
  });
  const result = await response.json<OpenAIResponse>();
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${result.error?.message ?? "bilinmeyen hata"}`);
  const tweet = cleanDraft(responseText(result));
  if (!tweet) throw new Error("OpenAI boş tweet döndürdü");
  const digest = await sha256(`${item.source_ref}\n${source.text}\n${source.attachments.map(file => file.url).join("\n")}`);
  await env.DB.prepare("INSERT OR REPLACE INTO ai_tweet_drafts(feed_item_id,tweet_text,model,source_digest,created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)").bind(item.id, tweet, MODEL, digest).run();
  return { tweet, cached: false };
}
