import type { FeedItem } from "../types";
import { fetchWithTimeout } from "../utils/http";
import { decodeEntities, stripHtml } from "../utils/text";
import { allowedSourceUrl } from "../sources/hosts";

export interface SourceAttachment { url: string; filename: string; isPdf: boolean; }
export interface SourceBundle { text: string; attachments: SourceAttachment[]; }

const FILE_NAME = /\.(?:pdf|docx?|xlsx?|csv|txt|xml)(?:$|[?#])/i;

function absoluteUrl(value: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(value), base);
    return allowedSourceUrl(url.toString()) ? url.toString() : null;
  } catch { return null; }
}

function walkArticleData(value: unknown, output: string[]): void {
  if (Array.isArray(value)) return value.forEach(item => walkArticleData(item, output));
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["headline", "description", "articleBody", "text"]) {
    if (typeof record[key] === "string" && record[key].trim()) output.push(record[key].trim());
  }
  for (const nested of Object.values(record)) if (nested && typeof nested === "object") walkArticleData(nested, output);
}

export function extractReadableContent(html: string): string {
  const parts: string[] = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walkArticleData(JSON.parse(decodeEntities(match[1])), parts); } catch { /* malformed publisher JSON-LD */ }
  }
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  parts.push(stripHtml(withoutNoise));
  const text = [...new Set(parts.map(part => decodeEntities(part).replace(/\s+/g, " ").trim()).filter(Boolean))].join("\n\n");
  if (text.length>100_000) throw new Error('Kaynak güvenli içerik boyutunu aşıyor; sessizce kesilmedi');
  return text;
}

export function extractAttachments(html: string, baseUrl: string): SourceAttachment[] {
  const found = new Map<string, SourceAttachment>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(match[1], baseUrl);
    const label = stripHtml(match[2]);
    if (!url || (!FILE_NAME.test(url) && !FILE_NAME.test(label) && !url.includes("/api/file/download/") && !url.includes("/api/BildirimPdf"))) continue;
    const fallback = new URL(url).pathname.split("/").pop() || "ek-dosya";
    const filename = (label.match(/[^/\\]+\.(?:pdf|docx?|xlsx?|csv|txt|xml)/i)?.[0] ?? fallback).slice(0, 180);
    found.set(url, { url, filename, isPdf: /\.pdf$/i.test(filename) });
  }
  return [...found.values()];
}

export async function fetchSourceBundle(item: FeedItem): Promise<SourceBundle> {
  if (item.category === 'resets') return {text:`Kaynak: Codex Resets\nBaşlık: ${item.title}\nDuyuru metni: ${item.body ?? ''}\nYayın zamanı: ${item.published_at ?? item.created_at}`,attachments:[]};
  let url=item.url;
  let response:Response|null=null;
  for(let attempt=0;attempt<4;attempt++) {
    if(!allowedSourceUrl(url)) throw new Error('unsupported_source');
    response=await fetchWithTimeout(url,{redirect:'manual',headers:{accept:'text/html,application/pdf,application/xhtml+xml','user-agent':'Mozilla/5.0 (compatible; VibeRadar/1.0)'}},25_000);
    if([301,302,303,307,308].includes(response.status)) {url=new URL(response.headers.get('location')??'',url).href;continue;}
    break;
  }
  if(!response || [301,302,303,307,308].includes(response.status)) throw new Error('redirect_limit');
  if (!response.ok) throw new Error(`Kaynak HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const metadata = [`Tür: ${item.type.toUpperCase()}`, `Kaynak: ${item.source}`, `Başlık: ${item.title}`, item.body ? `Kayıt özeti: ${item.body}` : "", `Yayın zamanı: ${item.published_at ?? item.created_at}`, `Kaynak URL: ${item.url}`].filter(Boolean).join("\n");
  if (contentType.includes("application/pdf") || /\.pdf(?:$|[?#])/i.test(item.url)) {
    return { text: metadata, attachments: [{ url: item.url, filename: `${item.source_ref.replace(/[^a-z0-9-]/gi, "-")}.pdf`, isPdf: true }] };
  }
  const html = await response.text();
  return { text: `${metadata}\n\nTAM KAYNAK METNİ:\n${extractReadableContent(html)}`, attachments: extractAttachments(html, item.url) };
}
