const KEYWORDS = [
  "bist", "borsa", "borsa istanbul", "hisse", "pay", "halka arz", "sermaye artır",
  "bedelsiz", "bedelli", "temettü", "geri alım", "birleşme", "satın alma", "yatırım",
  "finansal sonuç", "bilanço", "fon", "spk", "piyasa düzenlemesi", "endeks", "tcmb",
  "faiz", "enflasyon", "döviz", "kur", "altın", "petrol", "emtia", "bankacılık",
  "tahvil", "kredi derecelendirme", "ihracat", "cari açık", "işsizlik",
  "portföy", "portföy yönetim", "yatırım fonu", "emeklilik fonu", "fon yönetimi",
  "varlık yönetim", "serbest fon", "katılım fonu", "para piyasası fonu",
  "girişim sermayesi yatırım fonu", "gayrimenkul yatırım fonu", "yatırım ortaklığı"
];

// These short roots commonly occur inside unrelated Turkish words
// (for example `kur` in `tahtakurusu` and `pay` in `yapay`).
const EXACT_KEYWORDS = new Set(["pay", "kur", "fon", "altın"]);

function containsKeyword(text: string, keyword: string): boolean {
  if (!EXACT_KEYWORDS.has(keyword)) return text.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(text);
}

// Compact, deterministic dictionary. Extend this single file when the tracked universe grows.
const COMPANIES: Record<string, string> = {
  "THY": "THYAO", "TÜRK HAVA YOLLARI": "THYAO", "PEGASUS": "PGSUS", "ASELSAN": "ASELS", "TÜPRAŞ": "TUPRS", "TUPRAS": "TUPRS", "EREĞLİ": "EREGL", "EREGLI": "EREGL", "KOÇ HOLDİNG": "KCHOL", "KOC HOLDING": "KCHOL", "SABANCI HOLDİNG": "SAHOL", "AKBANK": "AKBNK", "GARANTİ BBVA": "GARAN", "GARANTI BBVA": "GARAN", "YAPI KREDİ": "YKBNK", "TURKCELL": "TCELL", "BİM": "BIMAS", "BIM": "BIMAS", "FORD OTOSAN": "FROTO", "TOFAŞ": "TOASO", "TOFAS": "TOASO", "PETKİM": "PETKM", "PETKIM": "PETKM", "ENKA": "ENKAI", "ŞİŞECAM": "SISE", "SISECAM": "SISE", "VESTEL MOBİLİTE": "VESTL", "VESTEL": "VESTL", "TERA YATIRIM": "TERA"
};

// Institutions without a safe, direct BIST ticker mapping still make a story
// relevant, but are deliberately not assigned a potentially wrong hashtag.
const WATCHED_INSTITUTIONS = [
  "tera portföy", "pusula finans", "pusula portföy", "bulls yatırım", "bulls portföy",
  "hedef portföy", "re-pie portföy", "pardus portföy", "istanbul portföy",
  "ata portföy", "ak portföy", "iş portföy", "garanti portföy", "ziraat portföy"
];

export function isRelevantNews(title: string, summary = ""): boolean {
  const normalized = `${title} ${summary}`.toLocaleLowerCase("tr-TR");
  return KEYWORDS.some(keyword => containsKeyword(normalized, keyword)) ||
    Object.keys(COMPANIES).some(company => normalized.includes(company.toLocaleLowerCase("tr-TR"))) ||
    WATCHED_INSTITUTIONS.some(institution => normalized.includes(institution));
}

// RSS providers occasionally put an international/English stream behind a
// Turkish label. We keep Turkish finance coverage, not untranslated wire copy.
export function isTurkishNews(title: string, summary = ""): boolean {
  const normalized = `${title} ${summary}`.toLocaleLowerCase("tr-TR");
  if (/[çğıöşü]/.test(normalized)) return true;
  const turkishWords = /\b(ve|ile|için|bir|bu|dolar|lira|piyasa|borsa|faiz|enflasyon|şirket|hisse|fon|türkiye|türk)\b/;
  const englishWords = /\b(the|and|of|in|to|as|is|for|with|from|between|live|major|trapped|breakout)\b/;
  return turkishWords.test(normalized) && !englishWords.test(normalized);
}

export function findTickers(title: string, summary = ""): string[] {
  const upper = `${title} ${summary}`.toLocaleUpperCase("tr-TR");
  const found = new Set<string>();
  for (const [company, ticker] of Object.entries(COMPANIES)) if (upper.includes(company)) found.add(ticker);
  for (const ticker of Object.values(COMPANIES)) {
    if (ticker === "TERA" && upper.includes("TERA PORTFÖY") && !upper.includes("TERA YATIRIM") && !upper.includes("#TERA")) continue;
    if (new RegExp(`(^|[^A-Z])${ticker}([^A-Z]|$)`).test(upper)) found.add(ticker);
  }
  return [...found];
}
