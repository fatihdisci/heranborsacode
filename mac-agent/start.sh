#!/bin/zsh
set -euo pipefail

AGENT_DIR="${0:A:h}"
ENV_FILE="${HERANBORSA_AGENT_ENV:-$HOME/.config/heranborsa-agent/env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Ajan yapılandırması bulunamadı: $ENV_FILE" >&2
  exit 1
fi
set -a
source "$ENV_FILE"
set +a
exec "$AGENT_DIR/.venv/bin/python" "$AGENT_DIR/heranborsa_agent.py"
