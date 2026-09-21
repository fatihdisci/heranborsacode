#!/usr/bin/env python3
"""Configure the Mac agent without printing or committing secret values."""

import argparse
import os
import secrets
import shlex
import subprocess
from pathlib import Path


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teleflow-env", type=Path)
    parser.add_argument("--teleflow-data", type=Path)
    args = parser.parse_args()
    home = Path.home()
    env_candidates = [
        args.teleflow_env,
        home / "Library/Application Support/TeleflowAgent/.env",
        home / "Apps/teleflow/mac-agent/.env",
    ]
    source_env = next((path for path in env_candidates if path and path.is_file()), None)
    if not source_env:
        raise SystemExit("Mevcut Teleflow .env bulunamadı. --teleflow-env ile tam yolunu verin.")
    existing = read_env(source_env)
    master_key = existing.get("TELEFLOW_MASTER_KEY")
    if not master_key:
        raise SystemExit("Seçilen dosyada TELEFLOW_MASTER_KEY bulunamadı.")
    data_dir = args.teleflow_data or home / "Library/Application Support/TeleflowAgent/data"
    if not (data_dir / "telegram.enc").is_file():
        raise SystemExit("telegram.enc bulunamadı. --teleflow-data ile data klasörünü verin.")

    project_dir = Path(__file__).resolve().parent.parent
    token = secrets.token_urlsafe(48)
    result = subprocess.run(
        ["npx", "wrangler", "secret", "put", "COMMAND_AGENT_TOKEN"],
        cwd=project_dir,
        input=token + "\n",
        text=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit("Cloudflare sırrı kaydedilemedi. Wrangler oturumunu kontrol edip yeniden çalıştırın.")

    target = home / ".config/heranborsa-agent/env"
    target.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join([
        "HERANBORSA_BASE_URL=https://heranborsa.av-fatihdisci.workers.dev",
        f"COMMAND_AGENT_TOKEN={shlex.quote(token)}",
        f"TELEFLOW_MASTER_KEY={shlex.quote(master_key)}",
        f"TELEFLOW_DATA_DIR={shlex.quote(str(data_dir))}",
        "COMMAND_POLL_SECONDS=3",
        "",
    ])
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(content)
    os.chmod(target, 0o600)
    print(f"Ajan yapılandırıldı: {target} (gizli değerler gösterilmedi)")


if __name__ == "__main__":
    main()
