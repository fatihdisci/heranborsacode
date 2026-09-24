(() => {
  'use strict';
  const ext=globalThis.browser??globalThis.chrome;
  const field=document.querySelector('#token'),status=document.querySelector('#status');
  ext.storage.local.get('safariExtensionToken').then(saved=>{
    if(saved.safariExtensionToken) status.textContent='Token kayıtlı. Değiştirmek için yenisini girin.';
  });
  document.querySelector('#settings').addEventListener('submit',async event=>{
    event.preventDefault();
    const token=field.value.trim();
    if(token.length<32){status.textContent='Token en az 32 karakter olmalı.';return;}
    await ext.storage.local.set({safariExtensionToken:token});
    field.value='';
    status.textContent='Token kaydedildi.';
  });
  document.querySelector('#token-file').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    try {
      const token=(await file.text()).trim();
      if(token.length<32) throw new Error('invalid');
      await ext.storage.local.set({safariExtensionToken:token});
      event.target.value='';status.textContent='Token kaydedildi; yerel dosyayı silebilirsiniz.';
    } catch {status.textContent='Token dosyası okunamadı veya biçimi geçersiz.';}
  });
})();
