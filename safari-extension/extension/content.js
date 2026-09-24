(() => {
  'use strict';
  const ext=globalThis.browser??globalThis.chrome;
  const H=globalThis.VibeRadarHelpers;
  const handled=new WeakSet();
  let current=null,scheduled=false,lastHref=location.href;

  function stylesheet(root) {
    const link=document.createElement('link');
    link.rel='stylesheet';link.href=ext.runtime.getURL('styles.css');
    root.append(link);
  }
  function ownElements(article,selector) {
    return [...article.querySelectorAll(selector)].filter(node=>node.closest('article[data-testid="tweet"]')===article&&!node.closest('[data-testid="quoteTweet"]'));
  }
  function textOf(element) {return (element?.innerText??element?.textContent??'').trim();}
  function referenceFrom(article) {
    const mainText=ownElements(article,'[data-testid="tweetText"]')[0];
    const links=ownElements(article,'a[href*="/status/"]');
    const prioritized=[...links.filter(link=>link.querySelector('time')),...links.filter(link=>!link.querySelector('time'))];
    const status=H.extractTweetUrl(prioritized.map(link=>link.href));
    const userName=ownElements(article,'[data-testid="User-Name"]')[0];
    const handle=status?.url.match(/^https:\/\/x\.com\/([^/]+)\/status\//)?.[1]??textOf(userName).match(/@([A-Za-z0-9_]{1,15})/)?.[1];
    const authorName=textOf(userName).split(/\s+@/)[0];
    const quote=article.querySelector('[data-testid="quoteTweet"]');
    let quotedTweet;
    if(quote) {
      const quoteText=textOf(quote.querySelector('[data-testid="tweetText"]'));
      if(quoteText) {
        const quoteStatus=H.extractTweetUrl([...quote.querySelectorAll('a[href*="/status/"]')].map(link=>link.href));
        const quoteHandle=quoteStatus?.url.match(/^https:\/\/x\.com\/([^/]+)\/status\//)?.[1];
        quotedTweet={text:quoteText,...(quoteStatus?{url:quoteStatus.url}:{}),...(quoteHandle?{authorHandle:quoteHandle}:{})};
      }
    }
    return H.normalizeReference({text:textOf(mainText),id:status?.id,url:status?.url,authorName,authorHandle:handle,quotedTweet});
  }
  function close() {if(current){current.host.remove();current=null;}}
  function messageFor(error) {
    return ({token_missing:'Ayarlar ekranında token girin.',unauthorized:'Token yanlış. Ayarlardan kontrol edin.',rate_limited:'Dakikalık sınır doldu. Biraz sonra deneyin.',network_error:'Sunucuya ulaşılamadı.',unsupported_page:'Bu sayfada kullanılamıyor.',generation_failed:'Taslak oluşturulamadı. Tekrar deneyin.'})[error]??'Taslak oluşturulamadı.';
  }
  function position(pop,button) {
    const rect=button.getBoundingClientRect();
    const width=Math.min(360,window.innerWidth-24);
    const left=Math.max(12,Math.min(rect.left,window.innerWidth-width-12));
    const top=rect.bottom+8+420>window.innerHeight?Math.max(12,rect.top-428):rect.bottom+8;
    pop.style.left=`${left}px`;pop.style.top=`${top}px`;pop.style.width=`${width}px`;
  }
  function open(article,button) {
    close();
    const reference=referenceFrom(article);
    const host=document.createElement('div');host.className='vr-popover-host';host.style.position='fixed';host.style.zIndex='2147483647';
    const shadow=host.attachShadow({mode:'closed'});stylesheet(shadow);
    const panel=document.createElement('section');panel.className='vr-panel';
    panel.innerHTML='<div class="vr-head"><strong>AI Taslak</strong><button type="button" class="vr-close" aria-label="Kapat">×</button></div><div class="vr-modes"><button type="button" data-mode="reply" class="active">Yanıt</button><button type="button" data-mode="quote">Alıntı</button></div><label>Benim notum (opsiyonel)<textarea class="vr-note" rows="2" maxlength="500" placeholder="Eklemek istediğiniz düşünce..."></textarea></label><button type="button" class="vr-generate">Oluştur</button><p class="vr-status" role="status"></p><textarea class="vr-draft" rows="5" aria-label="Düzenlenebilir taslak" hidden></textarea><div class="vr-actions" hidden><button type="button" class="vr-again">Yeniden oluştur</button><button type="button" class="vr-copy">Kopyala</button><button type="button" class="vr-intent">X\'te aç / yerleştir</button></div>';
    shadow.append(panel);document.body.append(host);position(host,button);
    const $=selector=>shadow.querySelector(selector);
    const state={host,article,button,mode:'reply',initialId:reference?.id,initialText:reference?.text};current=state;
    $('.vr-close').addEventListener('click',close);
    for(const modeButton of shadow.querySelectorAll('[data-mode]')) modeButton.addEventListener('click',()=>{
      state.mode=modeButton.dataset.mode;
      for(const candidate of shadow.querySelectorAll('[data-mode]')) candidate.classList.toggle('active',candidate===modeButton);
      $('.vr-intent').disabled=state.mode==='reply'?!reference?.id:!reference?.url;
    });
    async function generate() {
      if(current!==state||!article.isConnected){close();return;}
      const fresh=referenceFrom(article);
      if(!fresh||!fresh.text){$('.vr-status').textContent='Bu gönderide AI için yeterli metin yok.';return;}
      if((state.initialId&&fresh.id!==state.initialId)||(!state.initialId&&fresh.text!==state.initialText)) {close();return;}
      const payload=H.makePayload(state.mode,$('.vr-note').value,fresh);
      if(!payload){$('.vr-status').textContent='Gönderi metni okunamadı.';return;}
      $('.vr-generate').disabled=true;$('.vr-again').disabled=true;$('.vr-status').textContent='Yazılıyor…';
      try {
        const response=await ext.runtime.sendMessage({type:'VIBE_RADAR_GENERATE',payload});
        if(current!==state||!article.isConnected||location.href!==lastHref) return;
        if(!response?.draft){$('.vr-status').textContent=messageFor(response?.error);return;}
        $('.vr-draft').value=response.draft;$('.vr-draft').hidden=false;$('.vr-actions').hidden=false;
        $('.vr-intent').disabled=state.mode==='reply'?!fresh.id:!fresh.url;
        $('.vr-status').textContent='Taslağı düzenleyebilirsiniz. Gönderme işlemi sizde.';
        position(host,button);
      } catch {$('.vr-status').textContent='Sunucuya ulaşılamadı.';}
      finally {$('.vr-generate').disabled=false;$('.vr-again').disabled=false;}
    }
    $('.vr-generate').addEventListener('click',generate);
    $('.vr-again').addEventListener('click',generate);
    $('.vr-copy').addEventListener('click',async()=>{
      try {await navigator.clipboard.writeText($('.vr-draft').value);$('.vr-status').textContent='Kopyalandı.';}
      catch {$('.vr-status').textContent='Kopyalanamadı; metni seçip kopyalayın.';}
    });
    $('.vr-intent').addEventListener('click',()=>{
      const fresh=referenceFrom(article),draft=$('.vr-draft').value.trim();
      if(!fresh||!draft||((state.initialId&&fresh.id!==state.initialId)||(!state.initialId&&fresh.text!==state.initialText))) {close();return;}
      if((state.mode==='reply'&&!fresh.id)||(state.mode==='quote'&&!fresh.url)) {$('.vr-status').textContent='Gönderi bağlantısı bulunamadı; taslağı kopyalayın.';return;}
      const intent=new URL('https://x.com/intent/tweet');intent.searchParams.set('text',draft);
      if(state.mode==='reply') intent.searchParams.set('in_reply_to',fresh.id);
      else intent.searchParams.set('url',fresh.url);
      window.open(intent.href,'_blank','noopener,noreferrer');
    });
    if(!reference?.text) $('.vr-status').textContent='Bu gönderide AI için yeterli metin yok.';
  }
  function addButton(article) {
    if(handled.has(article)) return;handled.add(article);
    for(const stale of article.querySelectorAll('.vr-button-host')) stale.remove();
    const host=document.createElement('span');host.className='vr-button-host';
    const shadow=host.attachShadow({mode:'closed'});stylesheet(shadow);
    const button=document.createElement('button');button.type='button';button.className='vr-button';button.textContent='✦';button.setAttribute('aria-label','Bu gönderi için AI taslak');button.title='AI taslak';
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();open(article,button);});
    shadow.append(button);
    const action=ownElements(article,'[role="group"]')[0];
    (action??article).append(host);
  }
  function scan() {
    scheduled=false;
    if(location.href!==lastHref){lastHref=location.href;close();}
    if(current&&!current.article.isConnected) close();
    for(const article of document.querySelectorAll('article[data-testid="tweet"]')) addButton(article);
  }
  function schedule() {if(!scheduled){scheduled=true;requestAnimationFrame(scan);}}
  const observer=new MutationObserver(schedule);observer.observe(document.documentElement,{subtree:true,childList:true});
  document.addEventListener('click',event=>{if(current&&!event.composedPath().includes(current.host)&&!event.composedPath().includes(current.button))close();},true);
  window.addEventListener('scroll',()=>{if(current)position(current.host,current.button);},true);
  window.addEventListener('resize',()=>{if(current)position(current.host,current.button);});
  window.addEventListener('popstate',schedule);
  setInterval(()=>{if(location.href!==lastHref)schedule();else if(current&&!current.article.isConnected)close();},900);
  for(const stale of document.querySelectorAll('.vr-popover-host')) stale.remove();
  schedule();
})();
