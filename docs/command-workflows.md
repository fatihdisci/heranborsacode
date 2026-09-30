# Sıralı komut çalıştırma

30 Eylül 2026: 195 test / 24 dosya, tür kontrolü ve gerçek yerel Workerd + D1
fixture doğrulaması geçti. Kullanıcı yeni dar run/migration/yayın kapsamını onayladı.
`0021` yalnız yeni tablo + iki index olarak uygulandı; eski 44 iş / 427 sonuç
korundu, yeni workflow sayısı 0. Öncesindeki ücretsiz Time Travel bookmark:
`00000045-00004179-000050f6-19689eeb834e8c55a97e5ccef1383975`.
[Time Travel resmi bilgisi](https://developers.cloudflare.com/d1/reference/time-travel/)
ek maliyet olmadığını ve Free planın 7 günlük recovery penceresini açıklar.

Yeni kod `32e55c3e-11c7-4238-abbd-4fe8fd52f01e` olarak `--keep-vars` ile
yayımlandı; 8 asset değişmedi, 5 binding ve mevcut cron korundu. Komut bayrağı
henüz OFF. Parent 09:25:13 UTC mevcut list(limit1) okuma regresyonunu doğruladı.
Auth0 run permission eylemi ilk iki denemede action-time review ile durdu;
kullanıcının yeni anlık onayı sonrası yalnız `command-jobs:run` kaydedildi.
Aynı public client grant'i read+run 2/2 olarak kaydedildi; always-grant-all OFF,
M2M denied, diğer client'lar 0/2 kaldı. Bayrak ON yayını
`96f58885-6cf6-4c7c-a128-90ebc0b0fa66`; assets/bindings/cron tekrar korundu.
Safari mevcut plugin araç yenilemesi ve Yeniden bağla akışı tamamlandı;
taze UI **Primary artık bağlı** sonucunu gösterdi. Parent gerçek
`start_command_workflow` çağrısını 09:51:30 UTC'de başarıyla yaptı:
workflow `2633f7d3-25e7-4f66-a19c-73146337a2a3`, sabit key
`heranborsa-2026-09-30-midday-acceptance`, requested_at
`2026-09-30T09:51:30Z`. İlk Terane job
`0edfbd75-5699-4272-89b8-3fbb6d84ef7d` 09:51:44 UTC'de başladı,
09:54:09'da tamamlandı (14 tam sonuç). Kurum
`3a0607f4-b165-46b7-9635-5066eeb1d4e2` ancak bundan sonra 09:54:10'da
başladı ve 09:55:09'da tamamlandı (6 tam sonuç). Parent gerçek araçlarla
paketin `completed`, `requires_attention=false` ve global kilidin bırakılmış
olduğunu doğruladı. İkinci kabul paketi başlatılmadı. Otomasyonlar parent tarafından
saklama yayını ve kapsam kontrolü sonrasında kurulacaktır.
Geçici CF izinleri exact `user:read account:read workers_scripts:write d1:write`
ve zorunlu `offline_access` idi. Yayın tamamlandıktan sonra resmi logout başarılı;
Chrome dashboard Wrangler grant ayrıca Revoke edildi. Taze Connected Applications
ekranında **No connected applications found** doğrulandı; geçici oturum/link
dosyaları kaldırıldı. Canlı kabul için CLI yetkisi açık tutulmuyor.
Önceki reader sürümü `45972449` korunabilecek
rollback referansıdır; aktif paket varken eski claim koduna dönülmez.

## Dar yetki ve araç sözleşmesi

- Aynı RS256 issuer/JWKS, tam audience ve tek kullanıcı `sub` doğrulaması korunur.
- `start_command_workflow` hem `command-results:read` hem ayrı
  `command-jobs:run` ister. Eski okuma grant'i komut başlatamaz.
- `get_command_workflow` yalnız okuma izni ister; SELECT yapar, ilerletmez.
- `COMMAND_RUN_ENABLED` yok/false ise yeni araçlar discovery'de görünmez.
  Üç mevcut sonuç aracı ve mevcut reader korumaları çalışmaya devam eder.
- `market_round` sırası **Terane → Kurum**. Tekli `terane`, `kurum` ve
  `sonhalkaarzlar` modları yalnız aynı açık registry'deki şablonları çalıştırır.
  Son Halka Arzlar rutin pakete dahil edilmez.
- İstemci komut/bot/adım/başka şablon kimliği gönderemez. Şablonlar sunucudaki
  izinli üç ID'den okunur; başlangıçta isim/adımlar snapshot alınır. Sonradan
  şablon değişse de kabul edilen paket değişmez. Yeni şablon registry değişikliği
  ayrı inceleme/yetki gerektirir; otomatik blanket access yoktur.
- Mevcut katalog bot/komutları, şablon başına 1–80 adım, komut başına 160 karakter,
  adımlar arası 1–30 saniye sınırı korunur. Paket en fazla 160 adım içerir.
  Ajan botun ara yanıtlarını da bekleyebilir; adım sayısı bütün ağ trafiğini ifade etmez.
- Agent token, key, Telegram oturumu, template edit, keyfi legacy enqueue,
  X paylaşımı veya başka API yetkisi bu OAuth grant'ine dahil değildir.

Başlatma örneği (saat gerçek çağrının ilk UTC zamanı olmalıdır):

```json
{"mode":"market_round","request_key":"2026-09-30:midday:market_round","requested_at":"2026-09-30T09:30:00.000Z"}
```

Bir mantıksal slotun bütün retry'larında **aynı request_key ve requested_at**
kullanılır. Belirsiz ağ yanıtından sonra yeni anahtar oluşturulmaz. Aynı owner/key
eski workflow'u döndürür, tamamlanmış/başarısız olsa dahi yeniden komut göndermez.
Aynı key ile başka mod/zaman conflict'tir. Yeni talepler en fazla 10 dakika eski
ve 60 saniye ileri olabilir; geç kalmış slot sessizce çalıştırılmaz.

Başlatma sonucu `workflow_id`, `created`, `current_job_id`, snapshot adım sayıları
ve yalnız o paketin job ID'lerini verir. `get_command_workflow({workflow_id})`
normal çalışma sırasında 15 saniyelik önerilen bekleme döndürür. İlgisiz latest
job'a bakılmaz; sonuç/metin ve medya mevcut araçlardan **tam job ID ile** okunur.

## Atomiklik, sıralama ve hata davranışı

`0021_command_workflows.sql` yeni tablo + iki index ekler; mevcut satırları
değiştirmez. `(owner_sub,request_key)` unique'dir. `running/needs_attention`
satırlarında global unique index, `system_state` lock ve D1 transaction içindeki
koşullu job insert/CAS ilerleme birlikte kullanılır. Global tek paket aynı anda
tek kullanıcı paketini de sağlar. Başlangıçta başka queued/leased legacy iş varsa
`command_queue_busy` döner; yetim workflow/job oluşturulmaz.

Ajan claim'i kilidi atomik UPDATE sırasında tekrar kontrol eder. Paket aktifken
yalnız tam current job claim edilir; başka Mini App işi kuyruğa alınabilir ama
paket arasına girmez. Terane terminal **completed ve result_set_complete** olmadan
Kurum kuyruğa girmez. Concurrent complete/refresh çağrıları ikinci iş üretmez.
Lease-token CAS, complete replay'inin tekrar sonuç eklemesini engeller.

| Durum | Paket davranışı |
|---|---|
| Başarılı, bütün adım yanıtları saklandı | Sonraki snapshot işine geçer; son işte completed |
| failed/cancelled | failed; sıradaki çalışmaz, otomatik rerun yok |
| completed ama empty/partial/eksik adım/geçersiz medya referansı | partial; sıradaki çalışmaz |
| 10 dakika claim edilmemiş queued iş | Ajan yeniden temas ettiğinde CAS ile cancelled/timed_out; geç komut gönderilmez |
| Süresi dolmuş leased iş veya 120 dakika paket deadline | needs_attention; global kilit korunur, otomatik retry/sonraki iş yok |
| Belirsiz iş sonradan terminal döndü | timed_out; sıradaki iş çalışmaz, kilit kaldırılır |

Salt-okunur durum çağrısı süreyi aşmış işi gözlemsel `requires_attention` ile
bildirir; DB durumunu değiştirmez. Ajan yokken background cleanup/cron kurulmaz.
Ajan tamamen kaybolursa leased kilit insan incelemesine kadar tutulur; güvenli
otomatik unlock iddiası yoktur. Dot'a cancel/unlock veya sınırsız retry verilmez.
Mevcut legacy işler için eski expired-lease retry politikası ayrı kalır; bu yeni
workflow işlerinde expired lease yeniden claim edilmez.

## Sonuç tamamlığı içerik kanıtı değildir

`completed/result_set_complete` saklanan adım sonuçlarının tamamlığını ifade eder.
Görsel referansı olan ama metni boş sonuç da tamam olabilir. Görselin içi ayrıca
okunmalıdır; piyasa kapalı/boş görünmesi miktarın sıfır olduğunu kanıtlamaz.
`draft_evidence_state=requires_content_review`, `source_data_at=null` ve
`source_freshness=unknown` korunur. Talep/kayıt/okuma zamanı kaynak piyasa zamanı
yerine kullanılmaz. Araçlar miktar veya piyasa kapanışı tahmin etmez.
Durum/list/detail çağrıları R2 okumaz; medya yalnız açık medya çağrısında okunur.

## Ajan ve maliyet sınırı

Cloudflare D1/R2 kuyruk/sonuçları saklar; Telegram user-session komut yürütücüsü
`mac-agent/heranborsa_agent.py` ayrı ajan hostunda çalışır. Yerel şifreli session,
Telethon bağlantısı, bot erişimi ve çalışan süreç gerekir. Repo tasarımı gerçek
Mac mini sürecinin şu anda açık olduğunun kanıtı değildir. `last_seen_at` yalnız
queue temasını kanıtlar; Telegram hazır/güncel piyasa verisi garantisi vermez.

Ajan tek hostta process lock, sıralı adım/conversation bekleme, lease yenileme,
medya upload ve complete kullanır. FloodWait uzun sürebilir: sunucu deadline yeni
işi durdurur, hosttaki sürmekte olan Telegram isteğini zorla öldürmez. Harici başka
oturumların aynı botla paralel konuşmalarını bu global queue kilidi kontrol etmez.
Step/command/job kimliği korunur; sağlayıcının kaynak zamanı bilinmiyorsa bildirilir.

Yeni paid service yoktur. Worker/D1/R2 mevcut ücretsiz kotaya tabidir; sınırlı tek
kullanıcı talepleri, 80 adım/şablon, 5MiB MCP medya sınırı ve sadece talep edilen
medya okuması kullanılır. R2 Standard kota aşımı ücretlidir; sınırsız ücretsiz
garantisi yoktur. İşlem öncesi mevcut kota kontrol edilmelidir; kart/paid feature
veya ek ücret gerektiren aşamada durulur.

## Onaylı medya saklama

Yalnız önceki Türkiye gününün üç şablona ait terminal iş görsel/PDF dosyaları için
saklama kodu ve 0022 denetim tablosu hazırdır. Metinler ve aktif iş akışları korunur.
208 test / 25 dosya, tür kontrolü ve yerel Workerd + D1 + R2 doğrulaması geçti.
Eylem anı kullanıcı onayıyla günlük temizlik etkinleştirildi; ayrıntı ve güncel yayın durumu
[medya saklama rehberinde](command-media-retention.md) yer alır.
R2 kota aşımı ücretlidir; saklama birikimi azaltır, hesap genelinde sınırsız
ücretsiz kullanım garantisi oluşturmaz. Başka yazıcılar ve istek kotası ayrıca
mevcut ücretsiz plan sınırlarına tabidir. Ücretli seçenek kullanılmaz.

## Test ve yayına alma

`npm run check`, `npm test`, `npm run test:workflows:runtime`.
Son komut gerçek yerel Workerd + D1/fixture RS256 kullanır; canlı hesap, bot,
credential veya dış ağ kullanmaz. Yerel listener için sandbox izni gerekebilir.
Fixture yarışları, auth sınırları, eksik/failed/empty sonuç, offline timeout,
belirsiz lease, exact sıra, complete replay ve R2 okumama kapsanır.

Canlı adımlar yalnız açık kullanıcı onayıyla:

1. Aynı Auth0 API'ye sadece `command-jobs:run` permission ekle. Aynı public Native
   PKCE client ve tek owner grant'i `command-results:read command-jobs:run`
   kapsamına yükselt; refresh/offline önceki onaylı sınırda. M2M/DCR/başka kullanıcı
   veya command-agent kimliği ekleme. Kullanıcı ChatGPT reconsent'i tamamlar.
2. Geçici resmi Wrangler OAuth: `user:read account:read workers_scripts:write
   d1:write` ve CLI'nin zorunlu `offline_access`. Resmi scope açıklamasında D1:
   “See and change D1 Databases.” Yetki hesapta diğer Worker/D1'leri de kapsayabilir;
   yalnız Heran Borsa Worker + bağlı DB kullanılır. Kullanıcı final Authorize yapar.
   İzin ekranı farklı kapsam gösterirse dur. 120 saniye callback sınırı nedeniyle
   Chrome doğru hesapta hazır tutulur, ekran açılır açılmaz handoff yapılır.
3. Migration list/status ve `sqlite_master` salt-okunur kontrol: mevcut 0020'ye kadar
   uygulanmış olmalı. Bekleyen başka migration varsa topluca apply yapma. Yalnız
   0021'i resmi D1 migration transaction'ıyla uygula; başarısız transaction geri
   alınır. Mevcut satırları düzenleme/silme yok. D1 Time Travel recovery/bookmark
   resmi ücretsiz plan desteği varsa öncesinde kayıt et; ücretli backup başlatma.
4. Worker'ı `--keep-vars` ile yayımla; mevcut 8 asset, bindings, secret/vars ve cron
   korunur. Önce bayrak OFF iken mevcut reader/auth ve legacy agent davranışı kontrol
   edilir; tablo/grant hazırken sadece `COMMAND_RUN_ENABLED=true` etkinleştirilir.
5. Parent gerçek yeni-tool çağrısıyla tek `market_round` başlatır; aynı key retry,
   exact workflow/job, tam Terane→Kurum, kaynak/içerik ve medya kabulü doğrulanır.
   Geçmeden dört zaman dilimi otomasyonu kurulmaz. Hafta içi Türkiye 10:30,
   12–13, 16–17, 19–20 slotlarını parent automation aracı yönetir; Worker yeni cron
   oluşturmaz. Son Halka Arzlar açık istek olarak kalır.
6. İş bitince resmi logout + Cloudflare dashboard Wrangler grant Revoke; sunucu
   tarafında connected-app kaydı yokluğu doğrulanır. Geçici OAuth link dosyası
   kaldırılır. Grant/token/session chat'e veya patch'e konmaz.

Rollback: yeni başlatmaları kapat, mevcut aktif workflow'u incele; leased iş
sürerken eski claim koduna geri dönme (double-run riski). Yeni kod flag OFF iken
aktif kilidi korur. Aktif paket terminal olduktan sonra eski reader sürümüne dönüş
mümkündür; yeni tablonun kalması zararsızdır. Veri/sonuç satırlarını rollback için
silme. Auth0 run grant'i kaldırılabilir, mevcut read grant korunur.

## Q4 provenance (küçük salt-okunur kontrol)

`020bc99ee52d83887b0a1d2053c6ee476c4dfba3`, reader'ın baz checkout'u
`3e6de747cb24dd4096547946ad95f1d403ab78c2`'nin atasıdır (git merge-base kontrolü).
Mevcut `/tmp/heran-reader-build/index.js` bundle'ında `effectiveIndices`,
`2026-09-30T21:00:00Z` (1 Ekim 00:00 TRT), DSTKF→TRMET ve BIST100 değişimi vardır.
Yerel reader patch'i bu kaynakları değiştirmez. Son resmi deploy log'u
`/tmp/heran-reader-fix-deploy.log` sürüm `45972449-aef1-43e9-81a9-0d8d44b7c7e2`
yayınını kaydeder. Bu checkout/bundle/deploy provenance'ı Q4 kodunun reader
yayınında korunmasını destekler; bu tur canlı bundle indirilip hash karşılaştırması
ve 1 Ekim anındaki canlı davranış testi yapılmadı, yeni grant/deploy gerektirilmedi.
