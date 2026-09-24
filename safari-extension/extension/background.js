(() => {
  'use strict';
  const ext=globalThis.browser??globalThis.chrome;
  const ENDPOINT='https://borsa.discilaw.com/api/x-draft';
  ext.runtime.onMessage.addListener((message,sender) => {
    if(message?.type!=='VIBE_RADAR_GENERATE') return undefined;
    let origin;
    try {origin=new URL(sender.url).origin;} catch {return Promise.resolve({error:'unsupported_page'});}
    if(!['https://x.com','https://twitter.com'].includes(origin)) return Promise.resolve({error:'unsupported_page'});
    return (async()=>{
      const saved=await ext.storage.local.get('safariExtensionToken');
      const token=saved.safariExtensionToken;
      if(typeof token!=='string'||!token) return {error:'token_missing'};
      try {
        const response=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(message.payload),cache:'no-store',signal:AbortSignal.timeout(110_000)});
        const data=await response.json().catch(()=>({}));
        if(response.status===401) return {error:'unauthorized'};
        if(response.status===429) return {error:'rate_limited'};
        if(!response.ok||typeof data.draft!=='string') return {error:'generation_failed'};
        return {draft:data.draft};
      } catch {return {error:'network_error'};}
    })();
  });
})();
