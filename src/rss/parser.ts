import { decodeEntities, stripHtml } from "../utils/text";

export interface ParsedRssItem { title: string; description: string | null; url: string; publishedAt: string | null; }

function tag(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? stripHtml(match[1]) : null;
}

export function parseRss(xml: string): ParsedRssItem[] {
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
  return blocks.flatMap(block => {
    const title = tag(block, "title");
    const description = tag(block, "description") ?? tag(block, "content") ?? tag(block, "summary");
    const guid = tag(block, "guid");
    const linkText = tag(block, "link");
    const href = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
    const url = href ?? linkText ?? guid;
    const date = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated");
    if (!title || !url || !/^https?:\/\//.test(url)) return [];
    const parsed = date ? new Date(decodeEntities(date)) : null;
    return [{ title, description, url: decodeEntities(url), publishedAt: parsed && !Number.isNaN(parsed.valueOf()) ? parsed.toISOString() : null }];
  });
}
