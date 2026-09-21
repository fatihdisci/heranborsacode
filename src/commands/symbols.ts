import { fetchWithTimeout } from "../utils/http";

const KAP_COMPANIES = "https://www.kap.org.tr/tr/bist-sirketler";
let memoryCache: { expires: number; symbols: string[] } | undefined;

export function extractKapSymbols(html: string): string[] {
  const symbols = new Set<string>();
  const pattern = /\/tr\/sirket-bilgileri\/ozet\/[^\"]+\"><div>([A-Z0-9]{4,5})<\/div>/g;
  for (const match of html.matchAll(pattern)) symbols.add(match[1]);
  return [...symbols].sort();
}

export async function listBistSymbols(env: { DB: D1Database }): Promise<string[]> {
  if (memoryCache && memoryCache.expires > Date.now()) return memoryCache.symbols;
  const symbols = new Set<string>();
  try {
    const response = await fetchWithTimeout(KAP_COMPANIES, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; HeranBorsa/1.0)" },
    });
    if (response.ok) {
      for (const symbol of extractKapSymbols(await response.text())) symbols.add(symbol);
    }
  } catch { /* D1 fallback below keeps the selector usable. */ }
  const seen = await env.DB.prepare(`SELECT DISTINCT UPPER(j.value) AS symbol
    FROM feed_items, json_each(COALESCE(tickers_json,'[]')) j
    WHERE UPPER(j.value) GLOB '[A-Z0-9]*' ORDER BY symbol`).all<{ symbol: string }>();
  for (const row of seen.results ?? []) if (/^[A-Z][A-Z0-9]{3,4}$/.test(row.symbol)) symbols.add(row.symbol);
  const result = [...symbols].sort();
  memoryCache = { expires: Date.now() + 6 * 60 * 60 * 1000, symbols: result };
  return result;
}
