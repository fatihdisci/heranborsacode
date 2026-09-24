(() => {
  'use strict';
  const ext=globalThis.browser??globalThis.chrome;
  const ENDPOINTS=['https://borsa.discilaw.com/api/x-draft','https://heranborsa.av-fatihdisci.workers.dev/api/x-draft'];
  ext.runtime.onMessage.addListener((message,sender) => {
    if(message?.type!=='VIBE_RADAR_GENERATE') return undefined;
    let origin;
    try {origin=new URL(sender.url).origin;} catch {return Promise.resolve({error:'unsupported_page'});}
    if(!['https://x.com','https://twitter.com'].includes(origin)) return Promise.resolve({error:'unsupported_page'});
    return (async()=>{
      const saved=await ext.storage.local.get('safariExtensionToken');
      const token=saved.safariExtensionToken;
      if(typeof token!=='string'||!token) return {error:'token_missing'};
      for(const [index,endpoint] of ENDPOINTS.entries()) {
        try {
          const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(message.payload),cache:'no-store',signal:AbortSignal.timeout(index===0?12_000:110_000)});
          const data=await response.json().catch(()=>({}));
          if(response.status===401) return {error:'unauthorized'};
          if(response.status===429) return {error:'rate_limited'};
          if(!response.ok||typeof data.draft!=='string') return {error:'generation_failed'};
          return {draft:data.draft};
        } catch { /* Try the same Worker on its direct hostname if the public domain is unavailable. */ }
      }
      return {error:'network_error'};
    })();
  });
})();
