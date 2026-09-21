#!/bin/zsh
set -euo pipefail

SOURCE_DIR="${0:A:h}"
INSTALL_DIR="$HOME/Library/Application Support/HeranBorsaAgent"
LOG_DIR="$HOME/Library/Logs/HeranBorsaAgent"
PLIST="$HOME/Library/LaunchAgents/com.heranborsa.command-agent.plist"

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$HOME/.config/heranborsa-agent" "$HOME/Library/LaunchAgents"
rsync -a --delete --exclude '.venv' "$SOURCE_DIR/" "$INSTALL_DIR/"
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"
chmod 700 "$INSTALL_DIR/start.sh"
sed -e "s|__START_SCRIPT__|$INSTALL_DIR/start.sh|g" -e "s|__LOG_DIR__|$LOG_DIR|g" "$INSTALL_DIR/com.heranborsa.command-agent.plist.template" > "$PLIST"
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/com.heranborsa.command-agent" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.heranborsa.command-agent"
echo "Heran Borsa ajanı kuruldu. Durum: launchctl print gui/$(id -u)/com.heranborsa.command-agent"
