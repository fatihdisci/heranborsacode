# Mac mini Codex görevi

Heran Borsa projesinin Cloudflare tarafı ve dışarıdan iş çeken Mac ajanı hazır.
Bu Mac mini'de yalnızca ajanı güvenli biçimde kur, mevcut şifreli Teleflow
Telegram oturumunu yeniden kullan ve bağlantıyı doğrula.

Kurallar:

- Hiçbir API anahtarını, Telegram oturumunu, master key'i veya ajan tokenını
  terminal çıktısında ya da sohbet mesajında gösterme.
- Gizli değerleri repoya ekleme ve commit etme.
- Telegram kullanıcı oturumunu Cloudflare'a yükleme.
- Eski Teleflow ajanını veya verilerini silme.
- Heran Borsa ajanı doğrulanana kadar eski çalışan sistemi durdurma.

Yapılacaklar:

1. `~/Apps/heranborsa` varsa bu repoda çalış; yoksa özel
   `fatihdisci/heranborsacode` reposunu aynı konuma klonla. `git pull --ff-only`
   ile güncel kodu al. Beklenmeyen yerel değişiklik varsa onları silmeden durumu
   incele ve koru.
2. `npm ci` çalıştır; ardından `npm run check` ve `npm test` çalıştır. Testlerin
   tamamı geçmeden kuruluma devam etme.
3. `npx wrangler whoami` ile Cloudflare oturumunu kontrol et. Oturum yoksa
   kullanıcıdan yalnızca `npx wrangler login` işlemini tamamlamasını iste; token
   isteme veya ekrana yazdırma.
4. Mevcut Teleflow kurulumunda `telegram.enc` ve onu açan `.env` dosyasını
   yalnızca dosya varlığı bakımından bul. İçeriklerini terminale yazdırma.
   Beklenen varsayılan yollar:
   - `~/Library/Application Support/TeleflowAgent/data/telegram.enc`
   - `~/Library/Application Support/TeleflowAgent/.env`
   Kaynak kurulum farklı yerdeyse güvenli biçimde tam yolları tespit et.
5. Repo kökünde aşağıdaki yapılandırıcıyı çalıştır:
   `python3 mac-agent/configure.py`
   Varsayılan yollar uyuşmuyorsa yalnızca gerekli `--teleflow-env` ve
   `--teleflow-data` argümanlarını ver. Betik yeni `COMMAND_AGENT_TOKEN`
   değerini üretip Cloudflare Worker sırrına ve izinleri 600 olan yerel ajan
   yapılandırmasına kendisi yazar; değeri asla yazdırmaz.
6. `chmod +x mac-agent/install-launch-agent.sh mac-agent/start.sh` ve ardından
   `./mac-agent/install-launch-agent.sh` çalıştır. Bu işlem ajanı LaunchAgent
   olarak kurup macOS açılışında otomatik başlatır.
7. Ajan durumunu `launchctl print gui/$(id -u)/com.heranborsa.command-agent`
   ile kontrol et. Loglarda yalnızca son 50 satırı incele; gizli değer içeren
   dosyaları `cat` etme. Beklenen mesaj “Heran Borsa komut ajanı hazır.”dır.
8. 10 saniye sonra repo kökünde şu sorguyu çalıştır:
   `npx wrangler d1 execute DB --remote --command "SELECT value,updated_at FROM system_state WHERE key='command_agent_last_seen'"`
   Kayıt güncelse bağlantı tamamdır.
9. Eski Teleflow sistemine dokunmadan Mini App üzerinden tek bir zararsız B0PT
   `/doviz` testi kuyruğa alınmasını kullanıcıdan iste. Sonucun Heran Borsa bot
   sohbetine metin veya dosya olarak geldiğini doğrula. Başarılı olursa eski
   Teleflow ajanının ileride kapatılabileceğini bildir, ancak kendin kapatma.
10. Son raporda yalnızca test sonucu, LaunchAgent durumu, ajan son görülme zamanı
    ve test komutunun başarı/başarısızlık durumunu yaz. Hiçbir gizli değer yazma.
