# Heran Borsa

Cloudflare Workers + D1 üzerinde çalışan finans akışı: MKK/KAP bildirimleri, SPK bültenleri ve doğrulanmış RSS kaynaklarını normalize eder, tekilleştirir, Telegram'a iletir ve akıcı bir Telegram Mini App'te sunar. Kullanıcı istediğinde, kaynak metni ve ek dosyalar OpenAI Responses API ile okunarak yayıma hazır tweet taslağı oluşturulur.

## Mimari

`cron gözetmeni → bağımsız Durable Object alarmları (RSS kaynakları / KAP / SPK) → D1 kaynak tabloları + ortak feed_items → Telegram / REST / Mini App → isteğe bağlı AI tweet taslağı`

Dakikalık cron yalnız görev parçalarının alarmını denetler. Her RSS kaynağı kendi CPU bütçesiyle dakikada bir, canlı KAP taraması normalde 30 saniyede bir, geçmiş KAP doldurma işi 10 dakikada bir; SPK ise İstanbul saatine göre planlı aralıklarda çalışır. Canlı KAP taraması art arda geçerli bildirimler bulduğunda, alarm başına sabit küçük iş yükünü koruyarak geçici olarak 5 saniyelik yakalama moduna geçer ve güncel sınıra ulaştığında yeniden 30 saniyeye döner. Böylece yavaş veya hatalı bir kaynak diğer akışları geciktirmez. İlk kurulumdaki geçmiş kayıtlar Mini App için sessizce doldurulur, Telegram'a eski bildirim olarak yeniden gönderilmez. Sonraki yeni kayıtlar benzersiz kaynak kimlikleriyle tekilleştirilerek iletilir.

## Kurulum

1. `npm install`
2. `cp .dev.vars.example .dev.vars` ve gerçek değerleri yalnızca bu git-dışı dosyaya girin.
3. `wrangler d1 list` ile mevcut D1'in `database_name` ve `database_id` değerlerini bulun; `wrangler.toml` içindeki yer tutucuları bu değerlerle değiştirin.
4. `npm run db:migrate:remote`
5. `npm run deploy`

Local geliştirme için `npm run db:migrate:local` ardından `npm run dev` kullanın. `/health` D1 bağlantısını, cron zamanlarını ve her bağımsız tarama parçasının son başlangıç/bitiş/hata durumunu; `/api/feed?type=kap|spk|news&ticker=THYAO&q=...&cursor=...` zaman çizelgesini döndürür. Workers Logs açıktır; çalıştırma sonucu ve CPU süresi Cloudflare gözlemlenebilirlik ekranından izlenebilir.

## Secret kurulumu

Gerçek değerleri kaynak koda, `wrangler.toml`'a veya git'e koymayın. Her biri için:

```sh
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TELEGRAM_ALLOWED_USERNAME
wrangler secret put OPENAI_API_KEY
wrangler secret put MKK_API_KEY
wrangler secret put MKK_API_SECRET
```

`CLOUDFLARE_API_TOKEN` ve `CLOUDFLARE_ACCOUNT_ID` deploy ortamının kimlik bilgileridir; Worker runtime secret'ı değillerdir. `MKK_API_BASE_URL`, yalnızca MKK dokümantasyonundaki gerçek API kök URL'si doğrulandıktan sonra `wrangler.toml` `[vars]` alanına veya deploy değişkenlerine eklenmelidir. Sağlayıcının kaynak yolu/kimlik doğrulama şeması farklıysa sadece `src/kap/poll.ts` içindeki adapter güncellenir.

## RSS ve KAP kapsamı

RSS kaynak listesi `src/rss/sources.ts` içindedir; erişilebilirliği doğrulanmadan yeni feed eklemeyin. Akış filtresi ve ticker sözlüğü deterministiktir; AI yalnız kullanıcı tweet taslağı istediğinde devreye girer.

KAP akışı şirket, fon/portföy yönetimi ve piyasa açısından anlamlı bildirimleri kapsar. Pay alım/satım bildirimleri `src/kap/bist50.ts` içindeki güncellenebilir BIST 50 setiyle sınırlandırılır. DKB grubu ilk kaydın görülmesinden 12 saniye sonra kapanır; taramanın güncel sınıra ulaşmasını beklemez. Gruplar Telegram boyut sınırı için en fazla 100 kayıt içerir. Metin `#KOD #KOD2` ardından `Devre kesici uygulandı. Sürekli işleme ara verildi.` biçimindedir; AI kullanılmaz. Haberlerde başlık benzerliği tek başına eleme nedeni değildir; aynı başlık ve özet tekilleştirilirken yeni sayı/karar/özet veya aynı URL'deki revizyon ayrı kayıt olarak korunur.

## Telegram ve Mini App

BotFather'da **Menu Button / Web App URL** olarak deploy sonrası Worker URL'sini girin (ör. `https://heranborsa.<subdomain>.workers.dev`). Uygulamanın salt-okunur akışı normal tarayıcıda da çalışır. AI tweet endpoint'i yalnız Telegram Mini App'in imzalı `initData` verisi doğrulandıktan ve kullanıcı adı allowlist'i eşleştikten sonra çağrılabilir.

Kaynak, akış ve `telegram_outbox` aynı D1 transaction'ında kaydedilir. Bağımsız `telegram` alarmı boşken 3 saniyede bir kontrol eder; doluyken özel sohbete en az 1,1 saniye arayla tek mesaj yollar (gruplarda 3,1 saniye). SPK PDF'si açıklamasıyla tek gönderidir. Telegram 429 yanıtındaki `retry_after` tüm kuyruğa uygulanır; ağ/5xx hatalarında 5 saniyeden 5 dakikaya kadar artan bekleme vardır. Kalıcı 400/401/403/404 hataları `blocked` olarak görünür, diğer mesajları durdurmaz. Alarm çakışmaları için 90 saniyelik kalıcı sahiplenme kullanılır.

DKB grubunun üyeleri gönderimden önce sabitlenir; sonraki kayıtlar yanlışlıkla gönderildi sayılmaz. Bir üçüncü taraf Telegram çağrısında gerçek anlamda atomik/exactly-once teslimat mümkün değildir: Telegram kabulünden hemen sonra bağlantı ya da D1 yazımı koparsa tekrar denemede mükerrer mesaj olabilir. `message_id`, deneme sayısı ve hata kaydı bunu incelemeyi sağlar.

`monitor` dakikada bir denetler: üç ardışık kaynak hatası, zamanlanmış çalışmadan üç dakika sapma, 100'den fazla bekleyen mesaj, üç dakikadan uzun bekleme veya kalıcı gönderim hatası bir uyarı üretir. Sorun devam ederken sessiz kalır; düzelince tek iyileşme mesajı yollar. Haber çıkmaması hata değildir. Telegram veya tüm Cloudflare hizmeti kesilirse aynı kanaldan anlık uyarı garanti edilemez; durum `/health` üzerinden de görülebilir.

`/health.operations` son kuyruk durumunu ve son 500 teslimatın gecikmesini verir. İmzalı Mini App oturumuyla `/api/delivery?sourceRef=kap:...` kayıt bazında `published_at`, `first_seen_at`, `sent_at` ve Telegram mesaj kimliğini döndürür. İlk görülme RSS'e gerçek eklenme zamanı değildir; gönderim zamanı Telegram API kabulüdür, cihazda okunma zamanı değildir. SPK yayın tarihleri saat içermediği için yayın-ilk görülme farkı yaklaşık kabul edilmelidir.

AI promptu `src/ai/prompt.ts` içinde sürümlenir. GPT-5.6 Luna yalnız kullanıcı butona bastığında çalışır; aynı kaydın doğrulanmış taslağı önbellekten sunulur. Model gövdeyi yazar; doğrulanmış hashtagler ve kaynak URL uygulama tarafından eklenir. Tamamlanmamış model cevabı veya boyut sınırını aşan kaynak sessizce kesilerek kullanılmaz. Yeni sürüm ilk taslak isteğinde eski prompt önbelleğini yeniler.

## Kontrol

```sh
npm run check
npm test
curl https://YOUR_WORKER_URL/health
curl 'https://YOUR_WORKER_URL/api/feed?limit=10'
```
