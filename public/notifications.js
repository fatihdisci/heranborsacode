export function setupNotificationPreferences(telegram,onSaved,onOpen) {
  const $=s=>document.querySelector(s),dialog=$('#notification-settings'),fields=$('#notification-fields'),status=$('#notification-status');
  const headers=()=>({'x-telegram-init-data':telegram?.initData||'','content-type':'application/json'});
  let preferences,topics={},busy=false;
  const choices=(container,selected)=>{
    container.replaceChildren();
    for(const [key,text]of Object.entries(topics)){
      const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=key;input.checked=selected.includes(key);label.append(input,document.createTextNode(text));container.append(label);
    }
  };
  const selected=container=>[...container.querySelectorAll('input:checked')].map(el=>el.value);
  function watchRows(){
    const list=$('#watch-rules');list.replaceChildren();
    for(const rule of preferences.watchlist){
      const row=document.createElement('section');row.className='watch-rule';row.dataset.ticker=rule.ticker;
      const head=document.createElement('strong');head.textContent=rule.ticker;
      const mode=document.createElement('select');mode.setAttribute('aria-label',`${rule.ticker} bildirim kuralı`);
      for(const [value,text]of [['important','Bütün önemli KAP’lar'],['all','Tüm KAP’lar (rutin dahil)'],['topics','Yalnız seçilen konular']]){const option=document.createElement('option');option.value=value;option.textContent=text;mode.append(option);}
      mode.value=rule.mode;
      const remove=document.createElement('button');remove.type='button';remove.textContent='Kaldır';remove.setAttribute('aria-label',`${rule.ticker} takibini kaldır`);
      remove.onclick=()=>{read();preferences.watchlist=preferences.watchlist.filter(w=>w.ticker!==rule.ticker);watchRows();};
      const topicList=document.createElement('div');topicList.className='topic-choices';choices(topicList,rule.topics);topicList.hidden=rule.mode!=='topics';mode.onchange=()=>{topicList.hidden=mode.value!=='topics';};
      row.append(head,mode,remove,topicList);list.append(row);
    }
    if(!preferences.watchlist.length){const p=document.createElement('p');p.textContent='Takip listesi boş. Yukarıdan bir hisse ekleyebilirsin.';list.append(p);}
  }
  function fill(){
    watchRows();$('#other-company-mode').value=preferences.otherCompanies;choices($('#other-topics'),preferences.otherTopics);$('#other-topics').hidden=preferences.otherCompanies!=='topics';
    $('#fund-mode').value=preferences.funds;$('#digest-hour').value=String(preferences.digestHour);$('#digest-hour').disabled=preferences.funds!=='digest';
    $('#priority-indices').checked=preferences.priorityIndices;$('#excluded-titles').value=preferences.excludedTitles.join('\n');
  }
  function read(){
    preferences.watchlist=[...$('#watch-rules').querySelectorAll('.watch-rule')].map(row=>({ticker:row.dataset.ticker,mode:row.querySelector('select').value,topics:selected(row.querySelector('.topic-choices'))}));
    preferences.otherCompanies=$('#other-company-mode').value;preferences.otherTopics=selected($('#other-topics'));preferences.funds=$('#fund-mode').value;preferences.digestHour=Number($('#digest-hour').value);preferences.priorityIndices=$('#priority-indices').checked;preferences.excludedTitles=$('#excluded-titles').value.split('\n').map(t=>t.trim()).filter(Boolean);
  }
  for(let hour=0;hour<24;hour++){const option=document.createElement('option');option.value=String(hour);option.textContent=`${String(hour).padStart(2,'0')}:00`;$('#digest-hour').append(option);}
  $('#other-company-mode').onchange=()=>{$('#other-topics').hidden=$('#other-company-mode').value!=='topics';};
  $('#fund-mode').onchange=()=>{$('#digest-hour').disabled=$('#fund-mode').value!=='digest';};
  $('#notification-settings-button').onclick=async()=>{
    if(busy)return;busy=true;dialog.showModal();onOpen();fields.disabled=true;status.textContent='Kurallar yükleniyor…';
    try{
      const response=await fetch('/api/notification-preferences',{headers:headers()});if(!response.ok)throw new Error();
      const data=await response.json();preferences=data.preferences;topics=data.topics;fill();fields.disabled=false;status.textContent='';
      const age=Date.now()-Date.parse(data.indices.checkedAt);
      $('#index-freshness').textContent=`Endeksler KAP'tan son doğrulama: ${new Date(data.indices.checkedAt).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'})}. Etiketler güncel üyeliği gösterir; geçmişteki üyeliği göstermez.${age>3*86400000?' Liste üç günden eski; güncelleme bekleniyor.':''}`;
    }catch{status.textContent='Kurallar yüklenemedi. Pencereyi kapatıp tekrar açabilirsin.';}finally{busy=false;}
  };
  $('#notification-close').onclick=()=>dialog.close();
  $('#watch-add').onclick=()=>{
    const ticker=$('#watch-ticker').value.trim().toUpperCase();
    if(!/^[A-Z][A-Z0-9]{3,4}$/.test(ticker)){status.textContent='Geçerli bir hisse kodu yaz (ör. THYAO).';return;}
    read();if(preferences.watchlist.some(w=>w.ticker===ticker)){status.textContent='Bu hisse zaten takipte.';return;}
    if(preferences.watchlist.length>=100){status.textContent='En fazla 100 hisse takip edebilirsin.';return;}
    preferences.watchlist.push({ticker,mode:'important',topics:['dividend','buyback']});watchRows();$('#watch-ticker').value='';status.textContent='Listeye eklendi; uygulamak için Kaydet.';
  };
  $('#notification-example').onclick=()=>{
    read();if(!preferences.watchlist.some(w=>w.ticker==='THYAO'))preferences.watchlist.push({ticker:'THYAO',mode:'important',topics:[]});
    preferences.otherCompanies='topics';preferences.otherTopics=['dividend','buyback'];preferences.funds='digest';fill();status.textContent='THYAO takibi, diğer şirketlerde temettü/geri alım ve fon özeti dolduruldu. BIST önceliği mevcut seçimini korur. Uygulamak için Kaydet.';
  };
  $('#notification-save').onclick=async()=>{
    if(busy)return;read();
    if(preferences.watchlist.some(w=>w.mode==='topics'&&!w.topics.length)||preferences.otherCompanies==='topics'&&!preferences.otherTopics.length){status.textContent='Konu kuralı için en az bir konu seç.';return;}
    busy=true;fields.disabled=true;status.textContent='Kaydediliyor…';
    try{
      const response=await fetch('/api/notification-preferences',{method:'PUT',headers:headers(),body:JSON.stringify(preferences)});
      if(!response.ok)throw new Error();preferences=(await response.json()).preferences;status.textContent='Kaydedildi. Yeni kurallar etkin.';onSaved();
    }catch{status.textContent='Kaydedilemedi. Oturumunu ve kuralları kontrol edip yeniden dene.';}finally{busy=false;fields.disabled=false;}
  };
}
