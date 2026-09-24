# Vibe Radar

Fatih'in X hesabı için kişisel AI radar ve içerik hazırlama merkezi. Resmi kaynaklardaki model, ürün, coding agent, fiyat/limit ve Codex reset gelişmelerini toplar. Önemli kayıtları Telegram'a bildirir, tüm uygun kayıtları Telegram Mini App'te gösterir. X'e otomatik gönderi yapmaz. Tweet taslağı yalnız kullanıcı isteğiyle OpenAI Responses API üzerinden üretilir ve kopyalanır.

## Mimari

`Cloudflare cron → bağımsız PollShard Durable Object alarmları → kaynak adapterleri → D1 feed_items/ai_source_items → Mini App ve Telegram outbox`.

Her kaynak `src/sources/registry.ts` içinde kimlik, tür, URL, kategori, öncelik, tarama aralığı ve gerekiyorsa attribution taşır. RSS/Atom parser mevcut koddan kullanılır. Anthropic resmi sitemap'i ve Cursor resmi changelog sayfası için ayrı sayfa adapteri vardır. Codex Resets `/api/v1/resets` JSON adapteri ile okunur; `/api/v1/status` sağlık ve güncel durum için ayrıca alınır. Bir kaynak hatası diğerlerini durdurmaz. İlk başarılı tarama her kaynak için sessiz baseline oluşturur. Sonraki yüksek öncelikli yeni kayıtlar Telegram'a, normal kayıtlar yalnız Mini App'e girer. Filtreleme deterministiktir; polling OpenAI çağrısı yapmaz. URL ve içerik parmak izi ile tekrarlar elenir.

Kaynaklar: OpenAI News RSS; openai/codex GitHub Releases Atom; OpenAI Status Atom; Anthropic News sitemap; anthropics/claude-code GitHub Releases Atom; Claude Status Atom; GitHub Changelog RSS; Cursor Changelog; Google AI RSS; Google DeepMind RSS; [TechCrunch AI](https://techcrunch.com/category/artificial-intelligence/feed/), [The Verge AI](https://www.theverge.com/rss/ai-artificial-intelligence/index.xml), [MIT Technology Review AI](https://www.technologyreview.com/topic/artificial-intelligence/feed/) ve [Hugging Face Blog](https://huggingface.co/blog/feed.xml) RSS; [Codex Resets public API](https://codex-resets.com/api/docs). Dört yeni editoryal akış yalnız Mini App'te görünür. Codex Resets kayıtlarında Mini App ve Telegram üzerinde görünür [Codex Resets](https://codex-resets.com/) atfı bulunur. Kaynak URL'leri `src/sources/registry.ts` içinde ve 24 Eylül 2026'da HTTP yanıtları doğrulandı. OpenAI/Claude status akışları operasyonel bilgi olarak Mini App'te görünür; küçük durum değişiklikleri bildirim göndermez.

## Telegram ve Mini App

Bot komutları `/start`, `/son`, `/resetler`, `/durum`. Menu Button mevcut `PUBLIC_BASE_URL` adresinde Mini App'i açar. Mini App'in `initData` imzası ve yetkili kullanıcı adı mevcut doğrulama katmanında kontrol edilir. Akış, OpenAI, Claude, Coding, Resetler sekmeleri, konu arama ve kaynak seçimi vardır. Reader özgün makalenin erişilebilir metnini veya kayıtlı özeti gösterir. Bot mesajlarındaki Kaynağı aç, Oku ve Tweet oluştur butonları yalnız yetkili özel sohbette çalışır.

Telegram outbox mevcut kalıcı kuyruk, dedupe, lease, 429 `retry_after`, backoff ve teslimat durumlarını kullanır. `TelegramActions` mevcut okuma ve tweet eylemi işleyicilerini kullanır. Bir sağlayıcıya gönderim kabul edildiği anda D1 yazımı başarısız olursa üçüncü taraf API nedeniyle nadir mükerrer teslimat mümkün olabilir.

`migrations/0017_telegram_legacy_cleanup.sql` eski finans botunun kaydedilmiş mesaj kimlikleri için tek seferlik silme listesi oluşturur. Cron yalnız Telegram Bot API'nin 48 saatlik sınırı içinde kalan kimlikleri `deleteMessages` ile temizler; daha eski kayıtlar `expired` olarak işaretlenir. Silme durumu `telegram_legacy_cleanup` tablosunda izlenir. D1 haber geçmişi silinmez.

## AI tweet taslağı

`src/ai/tweet.ts` mevcut Responses API ve `gpt-6-luna` modelini tek çağrıyla kullanır. Kaynak sayfa veri sayılır, talimat sayılmaz. Kullanıcı isteği `language=tr`, `tone`, `note` ile üretim katmanına geçer; bu katman ileride başka bir istemci tarafından da çağrılabilir. İsteğe bağlı **Benim notum** alanı verilmedikçe kişisel deneyim eklenmemesi promptta açıkça belirtilir. Varsayılan Türkçe/doğal/not yok taslağı yeni prompt sürümüyle D1 cache'inde tutulur. Farklı ton veya kişisel not ile üretim cache'lenmez. Yabancı kaynaklardan ve ileride Safari eklentisinden gelen İngilizce referans tweetlerden de doğal Türkçe metin hazırlanması promptta tanımlıdır. Kaynak URL'si uygulama tarafından eklenir; otomatik hashtag eklenmez. Taslak X'e gönderilmez.

## Mevcut altyapı ve geçiş

`wrangler.toml` içindeki Worker adı, D1 `database_id`, R2 ve Durable Object binding/migration tag'leri korunur. Eski finans tabloları ve kayıtları silinmez. `migrations/0016_ai_radar.sql`, `feed_items` tablosuna AI kategori/öncelik/metadata alanları ve benzersiz kaynak kimlikleri için `ai_source_items` ekler. Eski kayıtların kategorisi NULL kalır ve yeni API onları göstermez. Eski `src/kap`, `src/spk`, `src/commands` ve `mac-agent` dosyaları geçiş güvenliği için legacy olarak durur; Worker route, cron ve Mini App tarafından çağrılmaz. Önceki PollShard alarm kayıtları da kullanılmaz. Finance secret'ları otomatik silinmez veya kullanılmaz.

Mevcut secret adları: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY`. Cloudflare secret değerlerini değiştirmeyin. `PUBLIC_BASE_URL` şimdilik mevcut adreste kalır. `COMMAND_AGENT_TOKEN`, `MKK_API_KEY`, `MKK_API_SECRET` legacy ortamda bulunabilir; yeni runtime bunları kullanmaz.

## Yerel geliştirme ve deploy

macOS Safari X yanıt/alıntı uzantısı için [kurulum rehberi](safari-extension/README.md) ve Apple converter ile üretilmiş Xcode projesi `safari-extension/` altındadır. `POST /api/x-draft`, Telegram kimliği yerine ayrı `SAFARI_EXTENSION_TOKEN` kullanır. Token yalnız Worker secret'ı ve uzantı ayarlarında saklanır. `0018_safari_extension_rate.sql` dakikada 15 üretim sınırını sağlar. Bu uzantı X'e otomatik gönderi paylaşmaz.

```sh
npm install
npm run db:migrate:local
npm run dev
npm run check
npm test
```

`.dev.vars` mevcutsa içeriğini değiştirmeyin; yeni kurulumda `.dev.vars.example` yalnız secret isimleri için rehberdir. Production'a geçmeden önce D1 yedeği almak önerilir. Production migration ve deploy komutları:

```sh
npm run db:migrate:remote
npm run deploy
```

`/health` public bir sağlık yanıtıdır: cron, her kaynak shard'ının son başarısı/hatası, Telegram shard'ı, Codex Resets durumu ve kuyruk istatistiklerini gösterir. Örnek: `curl https://YOUR_WORKER_URL/health`. Deploy sonrası mevcut Telegram webhook secret'ı varsa cron Menu Button ve komut listesini Vibe Radar olarak günceller; BotFather kullanıcı adını değiştirmek gerekmez.
