import {parseHTML} from 'linkedom';
import type {Source} from './registry';
import {fetchWithTimeout} from '../utils/http';
import {allowedSourceUrl} from './hosts';
function recent(value:string|null):boolean {const time=value?Date.parse(value):NaN;return Number.isFinite(time)&&time>=Date.now()-48*3600_000&&time<=Date.now()+3600_000;}
export interface PageItem {title:string;summary:string;url:string;publishedAt:string|null;}
export function parseSitemap(xml:string,host:string):Array<{url:string;modified:string}>{
  const rows=xml.match(/<url>\s*[\s\S]*?<\/url>/gi)??[];
  return rows.flatMap(block=>{
    const url=block.match(/<loc>(.*?)<\/loc>/i)?.[1], modified=block.match(/<lastmod>(.*?)<\/lastmod>/i)?.[1];
    if(!url||!modified)return [];
    try {const parsed=new URL(url);if(!allowedSourceUrl(url)||parsed.hostname!==host||!parsed.pathname.startsWith('/news/'))return [];return [{url,modified}];}catch{return [];}
  });
}
function meta(document:Document,name:string):string {return document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute('content')?.trim()??'';}
async function details(url:string,date:string|null):Promise<PageItem|null>{
  const response=await fetchWithTimeout(url,{headers:{accept:'text/html','user-agent':'VibeRadar/1.0 (+AI news reader)'}},15_000);
  if(!response.ok)return null;
  const {document}=parseHTML(await response.text());
  const title=meta(document,'og:title')||document.querySelector('h1')?.textContent?.trim()||'';
  const summary=meta(document,'description')||meta(document,'og:description');
  const time=date||document.querySelector('time')?.getAttribute('dateTime')||document.querySelector('time')?.getAttribute('datetime')||null;
  if(!title||!time||!recent(time))return null;
  return {title,summary,url,publishedAt:time};
}
export async function pageCandidates(source:Source,listing:string):Promise<PageItem[]>{
  if(source.kind==='sitemap'){
    if(!/<urlset\b/i.test(listing)) throw new Error('Invalid official sitemap');
    const entries=parseSitemap(listing,new URL(source.url).hostname).filter(row=>recent(row.modified)).slice(0,8);
    return (await Promise.allSettled(entries.map(row=>details(row.url,row.modified)))).flatMap(result=>result.status==='fulfilled'&&result.value?[result.value]:[]);
  }
  if(!listing.includes('/changelog/')) throw new Error('Invalid changelog page');
  const {document}=parseHTML(listing);
  const host=new URL(source.url).hostname;
  const urls=[...new Set([...document.querySelectorAll('a[href]')].map(a=>{try{return new URL(a.getAttribute('href')!,source.url).href;}catch{return '';}}).filter(url=>{try{const u=new URL(url);return allowedSourceUrl(url)&&u.hostname===host&&u.pathname.startsWith('/changelog/')&&!u.pathname.startsWith('/changelog/page/');}catch{return false;}}))].slice(0,10);
  return (await Promise.allSettled(urls.map(url=>details(url,null)))).flatMap(result=>result.status==='fulfilled'&&result.value?[result.value]:[]);
}
