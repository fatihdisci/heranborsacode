# Heran Borsa

Cloudflare Workers + D1 üzerinde çalışan, AI kullanmayan finans akışı: MKK/KAP bildirimleri, SPK bültenleri ve doğrulanmış RSS kaynaklarını normalize eder, tekilleştirir, Telegram'a iletir ve Telegram Mini App'te sunar.

## Mimari

`cron (15 dk) → KAP / RSS / (saat başında SPK) → D1 kaynak tabloları + ortak feed_items → Telegram / REST / Mini App`

Tek cron tetikleyicisi KAP ve RSS'i her 15 dakikada bir çalıştırır; SPK kontrolü sadece UTC saat başında yapılır. İlk başarılı SPK ve RSS çalışması geçmiş veriyi **baseline** olarak kaydeder, Telegram'a göndermez. Sonraki yeni kayıtlar gönderilir. KAP'ın ilk çalışması için sağlayıcının yeni bildirim endpoint'i kullanılması gerekir.

## Kurulum

1. `npm install`
2. `cp .dev.vars.example .dev.vars` ve gerçek değerleri yalnızca bu git-dışı dosyaya girin.
3. `wrangler d1 list` ile mevcut D1'in `database_name` ve `database_id` değerlerini bulun; `wrangler.toml` içindeki yer tutucuları bu değerlerle değiştirin.
4. `npm run db:migrate:remote`
5. `npm run deploy`

Local geliştirme için `npm run db:migrate:local` ardından `npm run dev` kullanın. `/health` D1 bağlantısını, `/api/feed?type=kap|spk|news&ticker=THYAO&q=...&cursor=...` zaman çizelgesini döndürür.

## Secret kurulumu

Gerçek değerleri kaynak koda, `wrangler.toml`'a veya git'e koymayın. Her biri için:

```sh
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put MKK_API_KEY
wrangler secret put MKK_API_SECRET
```

`CLOUDFLARE_API_TOKEN` ve `CLOUDFLARE_ACCOUNT_ID` deploy ortamının kimlik bilgileridir; Worker runtime secret'ı değillerdir. `MKK_API_BASE_URL`, yalnızca MKK dokümantasyonundaki gerçek API kök URL'si doğrulandıktan sonra `wrangler.toml` `[vars]` alanına veya deploy değişkenlerine eklenmelidir. Sağlayıcının kaynak yolu/kimlik doğrulama şeması farklıysa sadece `src/kap/poll.ts` içindeki adapter güncellenir.

## RSS ve KAP kapsamı

Başlangıç RSS listesi, yayıncının resmi RSS dizininde belirtilen `Habertürk Ekonomi` feed'idir. Kaynak listesi `src/rss/sources.ts` içindedir; erişilebilirliği doğrulanmadan yeni feed eklemeyin. Filtre ve ticker sözlüğü deterministiktir; AI ile özet veya ticker tahmini yoktur.

KAP yalnızca ODA, CA, FR ve piyasa/şirket açısından anlamlı DG bildirimlerini kabul eder; FON bildirimlerini hariç tutar. Pay alım/satım bildirimleri `src/kap/bist50.ts` içindeki güncellenebilir BIST 50 setiyle sınırlandırılır.

## Telegram ve Mini App

BotFather'da **Menu Button / Web App URL** olarak deploy sonrası Worker URL'sini girin (ör. `https://heranborsa.<subdomain>.workers.dev`). Uygulama normal tarayıcıda da çalışır. Feed herkese açık salt-okunur olduğu için Telegram `initData` doğrulamasına ihtiyaç duymaz; ileride kullanıcıya özel veya yazma yapan endpoint eklenirse initData backend'de HMAC doğrulanmadan güvenilmemelidir.

Telegram gönderimleri merkezî `src/telegram/client.ts` modülündedir; HTML escape, retry/backoff ve hata izolasyonu içerir. Bir üçüncü taraf Telegram çağrısında gerçek anlamda atomik/exactly-once teslimat mümkün olmadığından, D1 benzersiz kimlikleri tekrar üretimi engeller; belirsiz teslimat senaryoları operasyonel olarak incelenmelidir.

## Kontrol

```sh
npm run check
npm test
curl https://YOUR_WORKER_URL/health
curl 'https://YOUR_WORKER_URL/api/feed?limit=10'
```
