# Heran Borsa

Cloudflare Workers + D1 üzerinde çalışan finans akışı: MKK/KAP bildirimleri, SPK bültenleri ve basın duyuruları ile doğrulanmış RSS kaynaklarını normalize eder, tekilleştirir, Telegram'a iletir ve akıcı bir Telegram Mini App'te sunar. Kullanıcı istediğinde, kaynak metni ve ek dosyalar OpenAI Responses API ile okunarak yayıma hazır tweet taslağı oluşturulur.

## Mimari

`cron gözetmeni → bağımsız Durable Object alarmları (RSS kaynakları / KAP / SPK) → D1 kaynak tabloları + ortak feed_items → Telegram / REST / Mini App → isteğe bağlı AI tweet taslağı`

Komut Merkezi ayrı bir kalıcı hat kullanır:

`Mini App → D1 komut kuyruğu → Mac mini ajanı → harici Telegram botları → R2/D1 sonuçları → Heran Borsa bot sohbeti`

Dakikalık cron yalnız görev parçalarının alarmını denetler. Her RSS kaynağı ve SPK basın duyuruları kendi CPU bütçeleriyle dakikada bir, canlı KAP taraması normalde 30 saniyede bir, geçmiş KAP doldurma işi 10 dakikada bir; SPK bültenleri ise İstanbul saatine göre planlı aralıklarda çalışır. Canlı KAP taraması art arda geçerli bildirimler bulduğunda, alarm başına sabit küçük iş yükünü koruyarak geçici olarak 5 saniyelik yakalama moduna geçer ve güncel sınıra ulaştığında yeniden 30 saniyeye döner. Böylece yavaş veya hatalı bir kaynak diğer akışları geciktirmez. İlk kurulumdaki geçmiş kayıtlar Mini App için sessizce doldurulur, Telegram'a eski bildirim olarak yeniden gönderilmez. Sonraki yeni kayıtlar benzersiz kaynak kimlikleriyle tekilleştirilerek iletilir.

## Kurulum

1. `npm install`
2. `cp .dev.vars.example .dev.vars` ve gerçek değerleri yalnızca bu git-dışı dosyaya girin.
3. Mevcut production kurulumunda `wrangler.toml` içindeki D1 ve R2 kimliklerini koruyun.
4. `npx wrangler d1 migrations list DB --remote` ile migration durumunu kontrol edin. Herhangi bir migration bekliyorsa içeriğini incelemeden production'a uygulamayın.
5. `npm run check && npm test` ardından `npm run deploy` çalıştırın.

Local geliştirme için `npm run db:migrate:local` ardından `npm run dev` kullanın. `/health` D1 bağlantısını, cron zamanlarını ve her bağımsız tarama parçasının son başlangıç/bitiş/hata durumunu; `/api/feed?type=kap|spk|news&ticker=THYAO&q=...&cursor=...` zaman çizelgesini döndürür. Workers Logs açıktır; çalıştırma sonucu ve CPU süresi Cloudflare gözlemlenebilirlik ekranından izlenebilir.

## Secret kurulumu

Gerçek değerleri kaynak koda, `wrangler.toml`'a veya git'e koymayın. Her biri için:

```sh
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TELEGRAM_ALLOWED_USERNAME
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put OPENAI_API_KEY
wrangler secret put MKK_API_KEY
wrangler secret put MKK_API_SECRET
```

Mac mini ajanı kurulurken `COMMAND_AGENT_TOKEN`, `mac-agent/configure.py`
tarafından üretilir ve değeri ekrana yazılmadan hem Worker secret'ına hem izinleri
600 olan yerel yapılandırmaya kaydedilir.

`CLOUDFLARE_API_TOKEN` ve `CLOUDFLARE_ACCOUNT_ID` deploy ortamının kimlik bilgileridir; Worker runtime secret'ı değillerdir. Mevcut `MKK_API_BASE_URL` değeri `wrangler.toml` içinde korunur. Sağlayıcının kaynak yolu/kimlik doğrulama şeması farklıysa sadece `src/kap/poll.ts` içindeki adapter güncellenir.

## RSS ve KAP kapsamı

RSS kaynak listesi `src/rss/sources.ts` içindedir; erişilebilirliği doğrulanmadan yeni feed eklemeyin. Akış filtresi ve ticker sözlüğü deterministiktir; AI yalnız kullanıcı tweet taslağı istediğinde devreye girer.

KAP akışı şirket, fon/portföy yönetimi ve piyasa açısından anlamlı bildirimleri kapsar. Pay alım/satım bildirimleri `src/kap/bist50.ts` içindeki güncellenebilir BIST 50 setiyle sınırlandırılır. DKB grubu ilk kaydın görülmesinden 12 saniye sonra kapanır; taramanın güncel sınıra ulaşmasını beklemez. Gruplar Telegram boyut sınırı için en fazla 100 kayıt içerir. Metin `#KOD #KOD2` ardından `Devre kesici uygulandı. Sürekli işleme ara verildi.` biçimindedir; AI kullanılmaz. Haberlerde başlık benzerliği tek başına eleme nedeni değildir; aynı başlık ve özet tekilleştirilirken yeni sayı/karar/özet veya aynı URL'deki revizyon ayrı kayıt olarak korunur.

Fon/portföy temerrüdü ve tasfiye gibi kritik KAP gelişmeleri fon özeti seçili olsa da anında bildirilir. Fon kriziyle ilgili RSS haberleri doğrulanması gereken medya sinyali olarak işaretlenir; SPK basın duyurusu doğrudan resmî kaynaktan ayrı ve öncelikli gönderilir. Yeni SPK basın duyurusu izleyicisi ilk taramada mevcut kayıtları sessizce tanır ve geçmiş duyuruları Telegram'a yeniden yollamaz. Yeni basın duyurularının ana metni Mini App'te okunabilir ve tweet taslağına kaynak olur.

## Telegram ve Mini App

Botun **Menu Button / Web App URL** adresi `https://borsa.discilaw.com` olarak Worker tarafından korunur. Alt alan adı arama motorlarına kapalıdır; akış ve içerik API'leri yalnız Telegram Mini App'in imzalı `initData` verisi doğrulandıktan sonra çalışır. AI tweet endpoint'i ayrıca kullanıcı adı allowlist'ini denetler.

Kaynak, akış ve `telegram_outbox` aynı D1 transaction'ında kaydedilir. Bağımsız `telegram` alarmı boşken 3 saniyede bir kontrol eder; doluyken özel sohbete en az 1,1 saniye arayla tek mesaj yollar (gruplarda 3,1 saniye). SPK PDF'si açıklamasıyla tek gönderidir. Telegram 429 yanıtındaki `retry_after` tüm kuyruğa uygulanır; ağ/5xx hatalarında 5 saniyeden 5 dakikaya kadar artan bekleme vardır. Kalıcı 400/401/403/404 hataları `blocked` olarak görünür, diğer mesajları durdurmaz. Alarm çakışmaları için 90 saniyelik kalıcı sahiplenme kullanılır.

DKB grubunun üyeleri gönderimden önce sabitlenir; sonraki kayıtlar yanlışlıkla gönderildi sayılmaz. Bir üçüncü taraf Telegram çağrısında gerçek anlamda atomik/exactly-once teslimat mümkün değildir: Telegram kabulünden hemen sonra bağlantı ya da D1 yazımı koparsa tekrar denemede mükerrer mesaj olabilir. `message_id`, deneme sayısı ve hata kaydı bunu incelemeyi sağlar.

`monitor` dakikada bir denetler: üç ardışık kaynak hatası, zamanlanmış çalışmadan üç dakika sapma, 100'den fazla bekleyen mesaj, üç dakikadan uzun bekleme veya kalıcı gönderim hatası bir uyarı üretir. Sorun devam ederken sessiz kalır; düzelince tek iyileşme mesajı yollar. Haber çıkmaması hata değildir. Telegram veya tüm Cloudflare hizmeti kesilirse aynı kanaldan anlık uyarı garanti edilemez; durum `/health` üzerinden de görülebilir.

`/health.operations` son kuyruk durumunu ve son 500 teslimatın gecikmesini verir. İmzalı Mini App oturumuyla `/api/delivery?sourceRef=kap:...` kayıt bazında `published_at`, `first_seen_at`, `sent_at` ve Telegram mesaj kimliğini döndürür. İlk görülme RSS'e gerçek eklenme zamanı değildir; gönderim zamanı Telegram API kabulüdür, cihazda okunma zamanı değildir. SPK yayın tarihleri saat içermediği için yayın-ilk görülme farkı yaklaşık kabul edilmelidir.

AI promptu `src/ai/prompt.ts` içinde sürümlenir. `gpt-6-luna` yalnız kullanıcı butona bastığında çalışır; kaynak tekrar okunup içerik özeti (digest) eşleştiğinde önceki taslak önbellekten sunulur. URL içeriği değişebilen ek dosyalı kaynaklar yeniden değerlendirilir. Model gövdeyi yazar; doğrulanmış hashtagler ve kaynak URL uygulama tarafından eklenir. Tamamlanmamış model cevabı veya boyut sınırını aşan kaynak sessizce kesilerek kullanılmaz. Yeni sürüm ilk taslak isteğinde eski prompt önbelleğini yeniler. Ana metin diğer haberlerden ve menülerden ayrılır; finansal tablolar satır, başlık ve birleşik hücre bilgileriyle gönderilir. Ana metin ayrıştırılamazsa yalnız başlıktan taslak üretilmez. Prompt; işlem aşaması, taraf, dönem, para birimi, iddia/gerçek ayrımı ve ek kaynakların ilişkilendirilmesini zorunlu tutar. Modelin değerlendirme düzeyi medium, çıktı bütçesi 2400 tokendir; doğruluk kontrolü insan editörün yerini tutmaz.

## Komut Merkezi

Mini App'in **Komut** sekmesi yalnız `@b0pt_bot` ve `@ucretsizderinlikbot`
komutlarını, KAP'ın güncel BIST şirket listesinden aranan bir veya çok sayıda hisseyle birleştirir. Kullanıcı komutları
sıralayabilir, akışı adlandırıp kalıcı şablon olarak saklayabilir ve tek dokunuşla
kuyruğa alabilir. Bilinmeyen komutlar için özel komut alanı kullanılabilir. Bir akış en fazla 80 komut,
hisse seçimi en fazla 40 kod içerir.

Özel bot sohbetinde `/kurum` altı kurum sorgusunu, `/terane` on dört derinlik
sorgusunu, `/sonhalkaarzlar` ise on bir halka arz derinlik sorgusunu kuyruğa
alır. Telegram güncelleme tekrarları aynı işi ikinci kez oluşturmaz.
Kurum ve Terane şablonlarında komutlar arasındaki bekleme 3 saniyedir.
Kurum tamamlandığında bütün metinler tek mesaj veya sınır aşılırsa tek TXT ve
bütün görseller tek PDF olarak gönderilir. Terane ve Son halka arzlar tek birleşik
PDF olarak gelir; bu akışlarda tek tek ara sonuçlar Telegram sohbetine gönderilmez.

Kuyruk D1'da kalıcıdır. Mac mini kapalıyken işler kaybolmaz; ajan açıldığında
işleri dışarıdan HTTPS ile çeker. Telegram kullanıcı oturumu yalnız Mac mini'deki
şifreli `telegram.enc` içinde kalır. Medya sonuçları tahmin edilemez anahtarla R2'ye
yüklenir ve sonuçlar kendi bot sohbetine gönderilir. Mac kurulumu için
[`MAC_MINI_CODEX_PROMPT.md`](MAC_MINI_CODEX_PROMPT.md) ve
[`mac-agent/README.md`](mac-agent/README.md) kullanılır.

## Kontrol

Telegram haber ve DKB dışındaki KAP mesajlarında kaynak bağlantısının yanında **Oku** ve **Tweet oluştur** bulunur. Yanıt aynı özel sohbette ilgili mesaja cevap olarak gönderilir. Uzun metinler tek seferde sohbeti doldurmaz; **Devamını oku** kayıtlı metnin sonraki bölümünü getirir. Okuma, kaynak sayfanın erişilebilir metnini/tablosunu sunar; ek dosyalar bağlantı olarak belirtilir, eksik erişimde yalnız özet olduğu açıkça yazılır. Tweet, Mini App ile aynı model/prompt/önbelleği kullanır ve X'e yayınlanmaz.

Bu butonlar için `TELEGRAM_WEBHOOK_SECRET` rastgele, yüksek entropili bir Worker secret olarak kaydedilir. `/api/telegram/setup` GET/POST ve `/api/telegram/webhook` POST, `X-Telegram-Bot-Api-Secret-Token` başlığıyla doğrulanır. Setup POST webhook'u kaydeder ve son 10 uygun mesajın butonlarını günceller; farklı webhook varsa değiştirmez. GET yalnız yapılandırma/bekleyen güncelleme durumunu döndürür. Anahtarları komut satırına veya loglara yazmayın. İşlemler sadece `TELEGRAM_CHAT_ID` ile eşleşen özel sohbetin sahibi tarafından kullanılabilir.

`TelegramActions` Durable Object okuma ve AI için bağımsız iki işleyici kullanır; boşken alarm çalıştırmaz. Kalıcı `telegram_actions` kuyruğu tekrar gelen callback'leri ve hızlı çift tıklamaları tekilleştirir (dakikada en fazla 6 istek, toplam en fazla 8 bekleyen iş). Yanıtlar mevcut Telegram teslimat kuyruğuna girer. Kesilmiş AI işlemi otomatik tekrar ücretlendirilmez; hata mesajıyla kullanıcıdan tekrar denemesi istenir. Cron yalnız bekleyen işlerin alarmını denetler; kaynak tarama ritmi değişmez. OpenAI isteği 100 saniyeyle sınırlandırılır.

```sh
npm run check
npm test
curl https://YOUR_WORKER_URL/health
curl 'https://YOUR_WORKER_URL/api/feed?limit=10'
```


## X hesaplarından finans haberleri

`@haskologlu` ve `@ismailsaymaz` hesapları `nitter.cf` herkese açık RSS
akışlarından hesap başına bağımsız bir PollShard ile 3 dakikada bir kontrol edilir.
Ücretli X API, X API anahtarı veya tarayıcı oturumu kullanılmaz. Kaynak adresi
`wrangler.toml` içindeki `X_NITTER_BASE_URL`, hesap listesi
`src/x/sources.ts` içindedir. Adres değişkenini kaldırmak X kontrolünü kapatır.

İlk başarılı tarama başlangıç kaydı oluşturur; mevcut tweetler Mini App'e veya
Telegram'a gönderilmez. Sonraki taramalarda yalnız daha yeni, borsa/fon/sermaye
piyasası filtresine uyan paylaşımlar alınır. Genel siyaset ve günlük haberler
elenir. Retweetler ve yanıtlar alınmaz. Alıntı paylaşımlarının yazarları metinde
ayrı belirtilir. Aynı tweet kimliği yeniden alınmaz; veritabanı işlemi başarısız
olursa ilerleme kaydı da geri alınır. Migration gerekmez.

Kayıtlar Haber/Akış ekranında `X · @hesap` kaynağıyla görünür. Telegram'ın mevcut
outbox/retry ve taslak düğmeleri kullanılır. Okuyucu ve AI taslak üretimi RSS'ten
alınmış tam metni kullanır; görsel ve video içeriği okunmaz. X kaynaklı iddiaların
hesaba atfedilmesi finans editörü promptunda açıkça istenir.

Nitter erişilemezse kaynak başarısız olarak kaydedilir; kontrol aralığı kademeli
olarak 1 saate kadar uzar ve sunucunun `Retry-After` süresine uyulur. Üç ardışık
hata mevcut operasyon izleyicisinde uyarı oluşturur. `/health` içindeki
`x:haskologlu` ve `x:ismailsaymaz` kayıtları son başarılı kontrolü gösterir.
Herkese açık RSS'in içerik penceresi sınırlıdır; uzun kesintilerde arada kalan
paylaşımların tamamının alınması garanti edilmez.

## Takip listesi, BIST vurgusu ve bildirim kuralları

Mini App başlığındaki **🔔 Takip** düğmesi mevcut Telegram sohbetinin KAP
bildirim kurallarını düzenler. Kaydetmek için imzalı ve yetkili Telegram
Mini App oturumu gerekir. Kurallar sohbet kimliği altında mevcut D1
`system_state` tablosunda tutulur; bu özellik için migration veya secret değişikliği yoktur.

- **⭐ BIST 30**, **🔵 BIST 100** ve **🔔 Takip listem** hem akışta hem Telegram
  bildirimlerinde görünür. BIST 30 hisseleri 100 filtresine de dahildir.
- Akıştaki hızlı düğmeler takip listesi / BIST 30 / BIST 100 filtrelerini
  sayfalama öncesinde uygular. Bildirim filtresi kayıtları Mini App'ten silmez.
- Her takip edilen hisse için bütün önemli KAP'lar, rutinler dahil bütün KAP'lar
  veya seçili konular seçilebilir. Konular: temettü, geri alım, finansal sonuçlar,
  sermaye, sözleşme/iş ilişkisi, pay alım/satımı, devre kesici ve diğer.
- Diğer şirketlerde bütün önemli bildirimler, belirli konular veya kapalı seçilir.
  BIST önceliği varsayılan olarak açıktır; BIST 30/100 önemli bildirimleri bu
  filtreden etkilenmez. Pay alım/satımında eski BIST 50 sınırı, öncelikli BIST 100
  veya takip edilen hisseler için genişletilir. Rutin önem dışı başlıklar yalnız
  açık bir hisse/konu tercihi varsa alınır.
- Öncelik: hariç başlıklar → kritik fon gelişmesi → fon kuralı → hisseye özel kural → BIST önceliği →
  diğer şirketler. Birden çok takip edilen hisse eşleşirse izin veren kural yeterlidir.
- İhraç belgesi, fon ihraç sözleşmesi ve kredi kullanımı varsayılan olarak hariçtir. İç Tüzük, faizsiz pay dışı sermaye piyasası aracı işlemleri ve Kurumsal Yönetim Bilgi Formu Yönetim Kurulu-2 başlıkları kayıtlı tercihlerden bağımsız sessize alınır. Ek başlıklar arayüzden düzenlenebilir. Haber/RSS/X ve SPK gönderimleri
  bu KAP filtrelerinden etkilenmez.
- Fon/portföy kayıtları anlık, günlük özet veya kapalı olabilir. Özet varsayılan
  saati İstanbul 19:00; ayarlanabilir. Seçilen saatten sonra görülen kayıtlar
  bir sonraki özete girer. Özet AI kullanmaz: şirket/fon, bildirim başlığı ve kaynak
  bağlantılarını içerir; en fazla sekiz kayıtlık parçalara bölünür.
- Günlük özetler mevcut `telegram_outbox` içinde `digest` durumunda bekler,
  daha sonra sabit üyeli bir gönderim grubuna alınır; mevcut retry/429, lease
  ve gönderim makbuzu sistemi kullanılır. `filtered` kayıtlar saklanır ve
  kurallar yeniden açıldığında geriye dönük gönderilmez. Gönderim için hazırlanmış
  gruplar ve halen Telegram'a iletilen istekler önceki kuralla tamamlanabilir.
- KAP'ın resmi [endeks sayfası](https://www.kap.org.tr/tr/Endeksler) günlük okunur.
  30/100 üye sayısı, kod biçimi ve alt küme ilişkisi doğrulanmadan liste değiştirilmez.
  İlk başlangıçta 28.09.2026 tarihinde doğrulanan paketli liste kullanılır.
  Başarısız güncellemede son doğrulanan liste korunur; ayarlarda doğrulama tarihi
  ve üç günden eskiyse uyarı görünür. Rozetler geçmiş tarihteki üyeliği değil,
  son doğrulanan üyeliği gösterir.

`GET/PUT /api/notification-preferences` ayarları yönetir;
`GET /api/feed?scope=watchlist|bist30|bist100` öncelikli akışı getirir.
Yayın için tip kontrolü ve testlerden sonra standart `npm run deploy` yeterlidir;
bu özellik için `db:migrate:remote` çalıştırılmaz.
