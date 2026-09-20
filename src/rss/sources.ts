export interface RssSource { name: string; url: string; }

// Add a source only after validating its published feed URL. This deliberately
// starts small: the Habertürk URL is listed by its official RSS directory.
export const RSS_SOURCES: RssSource[] = [
  { name: "Habertürk Ekonomi", url: "https://www.haberturk.com/rss/ekonomi.xml" },
  { name: "NTV Ekonomi", url: "https://www.ntv.com.tr/ekonomi.rss" },
  { name: "Bloomberg HT", url: "https://www.bloomberght.com/rss" },
  { name: "Investing Türkiye", url: "https://www.investing.com/rss/news.rss" },
  { name: "Foreks", url: "https://www.foreks.com/rss" }
];
