# Heran Borsa Mac mini komut ajanı

Bu ajan Telegram kullanıcı oturumunu Mac mini dışına çıkarmaz. Cloudflare'a
yalnızca giden HTTPS bağlantıları kurar, kalıcı D1 kuyruğundan iş alır ve bot
yanıtlarını Heran Borsa sistemine geri yollar. Ev ağına port açılması, Funnel
veya Termius gerekmez.

## Gereken yerel değerler

`~/.config/heranborsa-agent/env` dosyası sadece Mac mini'de bulunmalıdır:

```dotenv
HERANBORSA_BASE_URL=https://borsa.discilaw.com
COMMAND_AGENT_TOKEN=Cloudflare-ile-ayni-gizli-deger
TELEFLOW_MASTER_KEY=mevcut-Teleflow-anahtari
TELEFLOW_DATA_DIR=/Users/KULLANICI/Library/Application Support/TeleflowAgent/data
COMMAND_POLL_SECONDS=3
```

Dosya izni `chmod 600 ~/.config/heranborsa-agent/env` olmalıdır. Telegram
`api_id`, `api_hash` ve oturum dizesi bu dosyaya taşınmaz; mevcut şifreli
`telegram.enc` doğrudan okunur.

Kurulum:

```zsh
python3 mac-agent/configure.py
chmod +x mac-agent/install-launch-agent.sh
./mac-agent/install-launch-agent.sh
```

Loglar `~/Library/Logs/HeranBorsaAgent/` altında tutulur ve hiçbir gizli değer
loga yazılmaz.

Ajan, Telegram bağlantısı koparsa yeniden bağlanır. Telegram erişimi geri gelene
kadar D1'dan yeni iş almaz; her komut öncesinde oturumu gerçek bir istekle
kontrol eder. Hata olursa Mini App geçmişine adım ve komut bilgisi kaydedilir.
Yanıt beklerken başarısız olan komutlar otomatik tekrar gönderilmez; bot komutu
zaten işlemiş olabilir.

Ajan bağlantı testleri (kurulu sanal ortamla):

```zsh
"$HOME/Library/Application Support/HeranBorsaAgent/.venv/bin/python" -B -m unittest discover -s mac-agent -p 'test_*.py'
```

Repository güncellemeleri kurulu ajana kendiliğinden geçmez. Güncellemeden sonra
kurulum betiğini yeniden çalıştırın; betik servis dosyalarını güncelleyip ajanı
yeniden başlatır.
