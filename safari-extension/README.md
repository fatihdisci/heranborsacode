# Vibe Radar X Safari extension

Bu macOS Safari WebExtension, x.com ve twitter.com üzerindeki metin içeren gönderilere ✦ butonu ekler. Yanıt ve alıntı taslaklarını mevcut Cloudflare Worker üzerinden varsayılan olarak ana tweetin dilinde üretir. Popover içindeki Dil menüsünden **Otomatik · Tweetin dili**, **Türkçe (TR)** veya **İngilizce (ENG)** seçilebilir. Türkçe kullanıcı notu otomatik dil seçimini değiştirmez. Telegram haber taslakları Türkçe kalır. X'te **Gönder** düğmesine dokunmaz.

## Kurulum

1. Backend'i dağıtın: repository kökünde `npm run db:migrate:remote` ve `npm run deploy`. `0018_safari_extension_rate.sql` geçişi dakikada 15 üretim sınırını oluşturur.
2. Cloudflare Worker'a `SAFARI_EXTENSION_TOKEN` secret'ını `npx wrangler secret put SAFARI_EXTENSION_TOKEN` komutuyla kaydedin. En az 32 karakterlik, rastgele ve yalnız size ait bir değer kullanın. Mevcut `OPENAI_API_KEY` değişmez. Token değerini git'e veya manifest'e koymayın.
3. [Xcode projesini](SafariApp/Vibe%20Radar%20X/Vibe%20Radar%20X.xcodeproj) açın. `Vibe Radar X` şemasını seçin; Signing & Capabilities bölümünde kendi Apple takımınızı seçin. App ve extension hedeflerinin bundle kimliklerini aynı önekle imzalayın. Run ile macOS uygulamasını derleyip açın.
4. Safari > Ayarlar > Uzantılar içinde **Vibe Radar X** uzantısını etkinleştirin. x.com (gerekirse twitter.com) erişimine izin verin. Worker adresleri `borsa.discilaw.com` ve gerektiğinde kullanılan doğrudan `heranborsa.av-fatihdisci.workers.dev` için ağ iznini de onaylayın.
5. Uzantı ayarlarını açıp 2. adımda kaydettiğiniz token'ı girin veya `SAFARI_EXTENSION_TOKEN` dosyasını içe aktarın. Token Safari WebExtension storage içinde saklanır; X sayfasına, content script'e veya loglara aktarılmaz.
6. x.com'da metin içeren bir gönderiyi açın. Gönderinin yanındaki ✦ düğmesinden Yanıt veya Alıntı seçin, isterseniz Benim notum alanını doldurun, Oluştur'a basın. Metni düzenleyin; Kopyala veya X'te aç / yerleştir ile composer'a aktarın. Son paylaşımı yalnız siz yaparsınız.

## İlk güvenli deneme

Bir test gönderisinde ✦ görünmesini kontrol edin. Benim notum boşken Yanıt taslağı oluşturun; X composer'ına yerleştirip **göndermeden** kapatın. Aynı adımları Alıntı için tekrarlayın. Gönderi yalnız medya içeriyorsa taslak oluşturulmaz.

## Teknik notlar

- WebExtension kaynakları [`extension/`](extension/) altındadır; Xcode projesi Apple'ın `xcrun safari-web-extension-converter` aracıyla üretildi ve bu dosyalara referans verir.
- Yanıt için `https://x.com/intent/tweet?in_reply_to=...&text=...` kullanılır. Alıntı için uzantı yalnız seçili gönderinin X üzerindeki **Alıntıla** menüsünü açar; alıntı kartında aynı gönderi doğrulanırsa taslağı editöre yerleştirir. Doğrulama başarısız olursa taslak popover'da kalır ve **Kopyala** kullanılabilir. Otomatik paylaşım yoktur.
- Yalnız x.com/twitter.com içerik erişimi, Worker host erişimi ve `storage` izni istenir. Backend'e `POST /api/x-draft` isteğini yalnız background yapar.
- Genel alan adına erişilemezse background aynı Worker'ın `workers.dev` adresini dener; `PUBLIC_BASE_URL` ve OpenAI key'i değişmez.
- X arayüzü değişirse güvenilir gönderi metni veya bağlantısı bulunamayabilir. Bu durumda taslak üretilmez veya composer düğmesi devre dışı kalır; Kopyala kullanılabilir.

## Başka Mac

Mac mini üzerinde Codex ile kurulum için [hazır görev promptunu](MAC_MINI_CODEX_PROMPT.md) kullanın. Mevcut üretim secret’ını değiştirmeyin; iki Mac aynı kişisel token ile çalışabilir.
