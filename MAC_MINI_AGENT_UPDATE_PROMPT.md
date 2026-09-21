# Mac mini Heran Borsa ajan güncellemesi

Mac mini üzerindeki mevcut `heranborsacode` kurulumunu güvenli biçimde güncelle.

1. Repo klasöründe `git pull --ff-only` çalıştır.
2. `npm ci`, `npm run check` ve `npm test` çalıştır; hata varsa durup sebebini açıkla.
3. Mevcut `.env`, şifreli Telegram oturumu ve ajan tokenına dokunma; hiçbir gizli değeri terminal çıktısına veya cevabına yazma.
4. Yeni ajan kodunu kurmak ve LaunchAgent’ı yeniden başlatmak için `./mac-agent/install-launch-agent.sh` çalıştır. `configure.py` çalıştırma; yeni token üretme.
5. `launchctl print gui/$(id -u)/com.heranborsa.command-agent` ile ajanın çalıştığını, sonra D1’de `command_agent_last_seen` kaydının güncellendiğini doğrula.
6. Mini App üzerinden tek bir `/doviz` testi çalıştır. Geçici “veri alınıyor” yanıtının sonuçlara ve Heran Borsa bot sohbetine gönderilmediğini; yalnızca botun son/düzenlenmiş yanıtının geldiğini doğrula.
7. Eski Teleflow ajanını silme veya durdurma.

İş bittiğinde test sonuçlarını ve doğrulanan davranışı kısa bir özetle bildir.
