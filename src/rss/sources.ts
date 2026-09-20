export interface RssSource { name: string; url: string; }

// Keep this list aligned with the proven source set from the previous bot.
export const RSS_SOURCES: RssSource[] = [
  { name: "Foreks", url: "https://www.foreks.com/rss" },
  { name: "Bloomberg HT", url: "https://www.bloomberght.com/rss" },
  { name: "Investing Türkiye", url: "https://tr.investing.com/rss/stock.rss" },
  { name: "Habertürk Ekonomi", url: "https://www.haberturk.com/rss/ekonomi.xml" },
  { name: "Sözcü Ekonomi", url: "https://www.sozcu.com.tr/rss/ekonomi.xml" }
];
