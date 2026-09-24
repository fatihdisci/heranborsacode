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
})();
