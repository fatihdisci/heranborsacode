// A single broad finance word is not enough. Economic RSS feeds also use words
// such as "yatırım", "faiz" and "petrol" for stories that have no meaningful
// connection to the user's BIST/KAP/fund focus.
const DIRECT_BIST_SIGNALS = [
  "bist", "borsa istanbul", "kap", "spk", "tefas", "devre kesici", "gyo",
  "borsada işlem gören"
];

const CAPITAL_MARKET_SIGNALS = [
  "halka arz", "sermaye artır", "bedelsiz", "bedelli", "temettü", "pay geri alım",
  "hisse geri alım", "finansal sonuç", "bilanço", "hedef fiyat", "model portföy",
  "aracı kurum", "takas analizi", "şirket pay", "pay sahip",
  "gayrimenkul yatırım ortaklığı", "menkul kıymet yatırım ortaklığı"
];

const FUND_SIGNALS = [
  "fon", "portföy", "portföy yönetim", "yatırım fonu", "emeklilik fonu", "fon yönetimi",
  "varlık yönetim", "serbest fon", "katılım fonu", "para piyasası fonu",
  "girişim sermayesi yatırım fonu", "gayrimenkul yatırım fonu"
];

const TURKEY_MARKET_ANCHORS = [
  "türkiye", "türk lirası", "dolar/tl", "euro/tl", "tcmb", "tüik", "bddk",
  "hazine ve maliye", "merkez bankası", "yurt içi", "masak", "mkk",
  "istanbul cumhuriyet başsavcılığı", "a.ş."
];

const MARKET_MOVING_MACRO_SIGNALS = [
  "politika faizi", "faiz kararı", "enflasyon", "tüfe", "üfe", "döviz", "kur",
  "rezerv", "cari açık", "işsizlik", "sanayi üretimi", "ekonomik büyüme",
  "kredi notu", "kredi derecelendirme"
];

// These short roots commonly occur inside unrelated Turkish words
// (for example `kur` in `tahtakurusu` and `pay` in `yapay`).
const EXACT_KEYWORDS = new Set(["fon", "kur", "kap", "spk", "bist", "tüfe", "üfe"]);

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

const NON_TICKER_ACRONYMS = new Set(["TEFAS", "MASAK", "TCMB", "BDDK", "BIST", "TÜİK", "OPEC"]);

export function isRelevantNews(title: string, summary = ""): boolean {
  const combined = `${title} ${summary}`;
  const normalized = combined.toLocaleLowerCase("tr-TR");
  const companyMatch = Object.keys(COMPANIES).some(company => normalized.includes(company.toLocaleLowerCase("tr-TR")));
  const institutionMatch = WATCHED_INSTITUTIONS.some(institution => normalized.includes(institution));
  const explicitTicker = [...combined.matchAll(/(?:#|\()([A-ZÇĞİÖŞÜ]{4,6})(?=\)|\b)/g)]
    .some(([,ticker]) => !NON_TICKER_ACRONYMS.has(ticker));
  if (companyMatch || institutionMatch || explicitTicker) return true;
  if (DIRECT_BIST_SIGNALS.some(signal => containsKeyword(normalized, signal))) return true;
  const localMarketContext = TURKEY_MARKET_ANCHORS.some(anchor => containsKeyword(normalized, anchor));
  if (localMarketContext && CAPITAL_MARKET_SIGNALS.some(signal => containsKeyword(normalized, signal))) return true;
  if (localMarketContext && FUND_SIGNALS.some(signal => containsKeyword(normalized, signal))) return true;
  return localMarketContext && MARKET_MOVING_MACRO_SIGNALS.some(signal => containsKeyword(normalized, signal));
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
