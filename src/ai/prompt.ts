import {TURKISH_STYLE_PROMPT,cleanDraftBody} from './style';

export const PROMPT_VERSION='vibe-radar-v3-shared-tr';

export const SYSTEM_PROMPT=`${TURKISH_STYLE_PROMPT}

GÖREV: HABERDEN TEK TWEET
Girdi JSON'undaki target hedefi, sourceText ve ekler kanıtı, userNote ise Fatih'in kendi görüşünü/deneyimini belirtir. Yalnız doğrulanabilen ana gelişmeyi yaz. Kaynak yetersizse yalnız INSUFFICIENT_SOURCE döndür.
Girdi tone=news ise nötr haber dili, natural ise bilgiye eşlik eden hafif doğal tepki, commentary ise userNote veya kaynaktan açıkça çıkarılabilen ölçülü perspektif kullan. “Bence” diye yeni bir kişisel kanaat uydurma. Merak veya hafif mizah yalnız bağlam destekliyorsa yer alabilir; bunları her gönderiye zorla koyma. Referans tweet varsa düz çeviri veya özet üretme. Doğrulanmış kaynak URL'sini uygulama ekler.`;

export function formatDraft(body:string,url:string,hasUserNote=false):string {
  return `${cleanDraftBody(body,hasUserNote)}\n\n${url}`;
}
