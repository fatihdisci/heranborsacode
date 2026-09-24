(() => {
  'use strict';
  const ID=/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{5,25})(?:\/.*)?$/;
  function statusInfo(value) {
    try {
      const url=new URL(value,'https://x.com');
      if(url.protocol!=='https:'||!['x.com','twitter.com','www.x.com','www.twitter.com'].includes(url.hostname)) return null;
      const match=ID.exec(url.pathname);
      if(!match) return null;
      return {id:match[1],url:`https://x.com${url.pathname.slice(0,url.pathname.indexOf('/status/')+8)}${match[1]}`};
    } catch {return null;}
  }
  function extractTweetId(value) {return statusInfo(value)?.id??null;}
  function extractTweetUrl(values) {
    for(const value of values) {const result=statusInfo(value);if(result)return result;}
    return null;
  }
  function shorten(value,max) {
    if(typeof value!=='string') return '';
    const clean=value.replace(/\s+/g,' ').trim();
    if(clean.length<=max) return clean;
    const prefix=clean.slice(0,max+1),cut=prefix.lastIndexOf(' ');
    return cut>max/2?prefix.slice(0,cut):'';
  }
  function normalizeReference(raw) {
    const text=shorten(raw?.text,2000);
    if(!text) return null;
    const status=raw?.url?statusInfo(raw.url):null;
    const id=/^\d{5,25}$/.test(String(raw?.id??''))?String(raw.id):status?.id;
    if(raw?.url&&!status) return null;
    if(status&&id&&status.id!==id) return null;
    const authorHandle=/^@?[A-Za-z0-9_]{1,15}$/.test(raw?.authorHandle??'')?raw.authorHandle.replace(/^@/,''):'';
    const result={text};
    if(id) result.id=id;
    if(status) result.url=status.url;
    if(authorHandle) result.authorHandle=authorHandle;
    const authorName=shorten(raw?.authorName,100);if(authorName) result.authorName=authorName;
    const parentTweetText=shorten(raw?.parentTweetText,1200);if(parentTweetText) result.parentTweetText=parentTweetText;
    if(raw?.quotedTweet) {
      const quoteText=shorten(raw.quotedTweet.text,1200);
      if(quoteText) {
        const quote={text:quoteText};
        const quoteStatus=raw.quotedTweet.url?statusInfo(raw.quotedTweet.url):null;
        if(quoteStatus) quote.url=quoteStatus.url;
        const handle=raw.quotedTweet.authorHandle;
        if(/^@?[A-Za-z0-9_]{1,15}$/.test(handle??'')) quote.authorHandle=handle.replace(/^@/,'');
        result.quotedTweet=quote;
      }
    }
    return result;
  }
  function makePayload(mode,userNote,reference) {
    if(!['reply','quote'].includes(mode)) return null;
    const normalized=normalizeReference(reference);
    if(!normalized) return null;
    return {mode,userNote:shorten(userNote??'',500),reference:normalized};
  }
  globalThis.VibeRadarHelpers=Object.freeze({statusInfo,extractTweetId,extractTweetUrl,normalizeReference,makePayload});
})();
