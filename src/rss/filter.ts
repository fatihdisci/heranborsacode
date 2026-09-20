const KEYWORDS = [
  "bist", "borsa istanbul", "halka arz", "sermaye artır", "bedelsiz", "bedelli", "temettü", "birleşme", "satın alma", "finansal sonuç", "bilanço", "spk", "tcmb", "faiz", "enflasyon", "döviz", "kur", "altın", "petrol", "emtia", "bankacılık", "tahvil", "kredi derecelendirme", "ihracat", "cari açık", "işsizlik"
];

// Compact, deterministic dictionary. Extend this single file when the tracked universe grows.
const COMPANIES: Record<string, string> = {
  "THY": "THYAO", "TÜRK HAVA YOLLARI": "THYAO", "PEGASUS": "PGSUS", "ASELSAN": "ASELS", "TÜPRAŞ": "TUPRS", "TUPRAS": "TUPRS", "EREĞLİ": "EREGL", "EREGLI": "EREGL", "KOÇ HOLDİNG": "KCHOL", "KOC HOLDING": "KCHOL", "SABANCI HOLDİNG": "SAHOL", "AKBANK": "AKBNK", "GARANTİ BBVA": "GARAN", "GARANTI BBVA": "GARAN", "YAPI KREDİ": "YKBNK", "TURKCELL": "TCELL", "BİM": "BIMAS", "BIM": "BIMAS", "FORD OTOSAN": "FROTO", "TOFAŞ": "TOASO", "TOFAS": "TOASO", "PETKİM": "PETKM", "PETKIM": "PETKM", "ENKA": "ENKAI", "ŞİŞECAM": "SISE", "SISECAM": "SISE"
};

export function isRelevantNews(title: string): boolean {
  const normalized = title.toLocaleLowerCase("tr-TR");
  return KEYWORDS.some(keyword => normalized.includes(keyword));
}

export function findTickers(title: string): string[] {
  const upper = title.toLocaleUpperCase("tr-TR");
  const found = new Set<string>();
  for (const [company, ticker] of Object.entries(COMPANIES)) if (upper.includes(company)) found.add(ticker);
  for (const ticker of Object.values(COMPANIES)) if (new RegExp(`(^|[^A-Z])${ticker}([^A-Z]|$)`).test(upper)) found.add(ticker);
  return [...found];
}

