# Heran Borsa Mac mini komut ajanı

Bu ajan Telegram kullanıcı oturumunu Mac mini dışına çıkarmaz. Cloudflare'a
yalnızca giden HTTPS bağlantıları kurar, kalıcı D1 kuyruğundan iş alır ve bot
yanıtlarını Heran Borsa sistemine geri yollar. Ev ağına port açılması, Funnel
veya Termius gerekmez.

## Gereken yerel değerler

`~/.config/heranborsa-agent/env` dosyası sadece Mac mini'de bulunmalıdır:

```dotenv
HERANBORSA_BASE_URL=https://heranborsa.arvia.site
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
