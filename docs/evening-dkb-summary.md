# DKB akşam özeti: yerel teslim ve yayın planı

Durum: MCP düzeltmesi ve DKB zamanlaması 30 Eylül 2026 tarihinde canlıya yayımlandı; etkin sürüm `1153f80c-3927-4498-9f8b-131523aaea5e`. Kaynak main: `6d40b8101b39557d5827b71112fbae494669ca14`. Önceki canlı MCP/workflow/saklama değişiklikleri bu checkout içinde korunarak güncel kullanıcı koduna uygulanmıştır. PAY otomatik çalışmaz; mevcut açık `/payozet` isteği çalışmaya devam eder.

## Tek üretici ve saat

Mevcut Worker dakika cron'u, `EVENING_SUMMARY_ENABLED=true` olduğunda Türkiye borsa iş günlerinde 20:30 dahil / 21:00 hariç DKB üretir. Yeni cron, Mac ajanı veya ikinci komut üreticisi yoktur. Aynı sohbet ve Türkiye tarihi tek kalıcı `system_state` kaydına bağlıdır. Eşzamanlı tick, hazırlık çökmesi ve belirsiz Telegram teslimi yeni özet üretmez. Bütün sayfaların Telegram makbuzları gelmeden completed olmaz. Başarısız/belirsiz gönderim durur; otomatik yeniden gönderim yoktur. Saat 21:00 olduğunda bekleyen sayfalar durdurulur; önceden başlamış harici gönderimin gecikmeli yanıtı mümkündür. Telegram kesintisinde pencere içinde teslim garantisi verilmez.

2026 Borsa İstanbul resmi takvimi doğrulanmış sabit listedir; yarım günler iş günüdür. Doğrulanmamış 2027 takviminde scheduler durur. Resmi kaynak: https://www.borsaistanbul.com/files/pay-piyasasi-2026-yili-tatil-tablosu.pdf . Gerekirse incelenmiş resmi takvim `EVENING_SUMMARY_CALENDAR_JSON` ile değiştirilir; otomatik ağ/takvim tahmini yapılmaz.

## MCP sözleşmesi

`get_evening_dkb_summary` yalnız SELECT yapar; mevcut aynı kullanıcı/issuer/audience ve `command-results:read` korumasını kullanır. Yeni Auth0 scope, grant veya komut başlatma yoktur. Keşifte readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false. Özellik kapalıyken araç keşfe eklenmez.

Argüman JSON schema:

```json
{"type":"object","properties":{"day":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"Türkiye tarihi YYYY-MM-DD; verilmezse bugün"},"page_offset":{"type":"integer","minimum":0,"default":0},"source_offset":{"type":"integer","minimum":0,"default":0}},"additionalProperties":false}
```

Çağrı: `{ "day": "2026-09-30", "page_offset": 0, "source_offset": 0 }`. Day yoksa bugünün Türkiye tarihi. Her sonraki çağrıda AYNI day kullanın. Metin 20 sayfalık, kaynak kayıtları 100 kayıtlık partilerle gelir. İlk çağrıdan başlayıp `next_page_offset` ve `next_source_offset` null olana dek ilgili offset'i ilerletin; diğer akış bitmişse onun önceki offset'i tutulabilir. Tek sonuçta pagination_complete=true olması önceki partilerin okunduğu anlamına gelmez: bütün partiler biriktirilmeli ve total sayılarıyla doğrulanmalıdır. Hiçbir metin karakteri veya hisse top-N ile kesilmez.

Normal sonuç alanları (zorunlu payload şekli):

- `schema_version:1`, `summary_id:"dkb:<day>"`, `kind:"dkb"`, `day`, `timezone:"Europe/Istanbul"`, `read_at` ISO UTC.
- `source_data_at:null` (piyasa veri anı uydurulmaz), `generated_at` hazırlık/cutoff ISO UTC, `data_scope:"registered_kap_disclosures"`, `coverage` kapsam açıklaması.
- `status: preparing_dkb | dkb_pending | completed | needs_attention`, `availability: pending | available | needs_attention`, `all_pages_sent:boolean`.
- `expected_pages`, `total_pages`, `pages:[{page:integer,text:string|null,status:string,message_id:number|null,sent_at:string|null}]`, `full_text` yalnız bu partinin bütün metinlerinin birleştirilmesi, `text_truncated:false`.
- `shares:[{ticker:string,circuit_breaker_count:integer}]` TÜM hisseler, `total_shares`, `shares_complete:true`, `shares_basis:"registered_circuit_breaker_counts"`.
- `source_records:[{disclosure_id,title,company,ticker,published_at,url,metadata_json}]`, `total_source_records`, `source_records_cutoff:generated_at`. Kaynaklar KAP D1 kayıtlarının Türkiye gününde, cutoff dahil yayımlanmış DKB kayıtlarıdır. Sonradan kolektöre gelen/yenilenen aynı yayın tarihli kaynaklar okumalarda görülebilir; kayıt kümesi değişirse total/ID kontrolüyle yeniden okuyun. Kolektörün genel filtreleri değiştirilmedi.
- `page_offset`, `next_page_offset:integer|null`, `source_offset`, `next_source_offset:integer|null`, `page_delivery_complete:boolean`, `pagination_complete:boolean`, `draft_evidence_state:"requires_content_review"`, `error:string|null`.

Henüz çalışma yoksa `status:not_started, availability:pending, full_text:"", shares:[], pages:[], source_records:[], pagination_complete:false`. Sohbet yoksa not_configured/unavailable. Bozuk state invalid_state/needs_attention. Eksik sayfa veya bozuk payload attention verir. Yanlış yetki 401; flag kapalıyken çağrı 503. Geçersiz tarih/offset/ek argüman reddedilir.

Kaynaklar: aynı sohbet/tarih `system_state`, tam outbox ID manifestine ait `telegram_outbox` plain metin/makbuzları ve `kap_disclosures` DKB kayıtları. R2 okuma veya gizli medya URL'si yoktur. DKB üretiminde tüm geçerli hisse kodları/sayım ve bütün özet sayfaları korunur; kodu belirlenemeyen kayıtlar kaynak listesinde kalır ve özette belirsiz sayılır. Özet kayıtlı kaynakların tamamını kapsar; henüz taranmamış KAP bildirimleri kapsandığı iddia edilmez.

## Parent otomasyonu

Parent akşam görevini yalnız READ olarak kurar. Bugünün exact day sonucu ve bütün sayfa/kaynak partileri alınır. Pending ise sınırlı bekleme/durum kontrolü yapılır; özet başlatılmaz, eski günün metni kullanılmaz. attention ise hata bildirilir. Bütün sayfalar alınmış, all_pages_sent=true ve kaynak total/ID bütünlüğü doğrulanmışsa parent bütün içeriği okuyup yalnız tweet/görsel aşamasında 5–10 hisseyi seçer. Hisse seçimi teslimden önce yapılmaz; sayım hacim veya yatırım önerisi değildir. X paylaşımı ayrıca açık kullanıcı talimatı gerektirir.

## Yayın için gerekenler

Bu özellik için migration YOK: mevcut system_state ve telegram_outbox tabloları kullanılır. Yeni D1 CLI yazma izni gerekmiyor. Geçici resmi Wrangler login için `user:read account:read workers_scripts:write` ve aracın zorunlu `offline_access` yetkisi; yalnız Heran Borsa Worker hesabı a4a8d96f9070fb7459caef85ae8dfa8b hedeflenir. Hesap kapsamlı Worker izni başka Worker'ları da kapsayabildiğinden yeni exact onay parent üzerinden alınmalıdır. Yayın için kullanılan geçici oturum resmi Wrangler logout ile kapatıldı; yerel kimlik bilgileri temizlendi. Ek server revoke isteği 403 verdiği için Connected applications ekranında sunucu iptali ayrıca doğrulanmalıdır.

Yayın öncesi sürüm `191e087e-14a0-494e-9d38-d1a49c7e843b` idi; yayın sonrası sürüm `1153f80c-3927-4498-9f8b-131523aaea5e` doğrulandı. İleride yapılacak her yayında güncel canlı sürüm yeniden doğrulanmalıdır. Kullanıcının yeni local/repo değişiklikleri tekrar kontrol edilir. Mevcut bindings, assets, dakika cron'u, read/run OAuth vars ve retention flag korunur; yayımlama --keep-vars ile yapılır. EVENING_SUMMARY_ENABLED=true etkinleştirildi; eksilen COMMAND_RUN_ENABLED=true ve COMMAND_MEDIA_RETENTION_MODE=delete geri kondu. Bu bayraklar sonraki yayınların koruması için wrangler.toml içinde de yer alır. Eski foundation migration'ları körlemesine yeniden uygulamayın. Yeni canlı araç gerçek read testinden sonra parent otomasyonu kurulur.

Native browser UI araçları bu oturumda yok. `wrangler login --help` resmi `--browser=false`, localhost callback, ayrıca `--device` desteğini doğruladı; timeout artırma seçeneği yok. Login URL veya credential sohbet içine yazılmaz. Handoff ve sunucu tarafı Revoke için parent/user tarayıcı adımı planlanmadan giriş başlatılmaz. İş sonunda resmi logout ve Cloudflare connected-app server revocation doğrulanır. Yeni kalıcı CF grant, Auth0 scope, kart veya ücretli hizmet oluşturulmaz. Mevcut ücretsiz kotalar altında ek kullanım doğar; sınırsız ücretsiz garanti verilmez.

## Kanıt

`npm run check`, `npm test` (237 test, 28 dosya). 550 hisse/kaynak, 25 sayfa ve 50.000 karakter üstü tam metin testleri; eşzamanlı tick/send, eksik manifest, uncertain send, makbuz DB hatası, pencere, resmi tatil, PAY otomatik yok, mevcut manuel retry/PAY korunumu.

`npm run test:evening:runtime`: gerçek yerel Workerd/D1, fixture RSA OAuth JWT, kaynak sayfalama, read scope/owner/audience sınırları, altı concurrent tick, sırayla tüm Telegram sayfaları, uncertain-send no replay. Bütün dış fetch'ler fixture ile yakalanır; gerçek hesap, token veya Telegram gönderimi kullanılmaz.
