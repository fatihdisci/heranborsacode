import asyncio
import fcntl
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
from cryptography.fernet import Fernet
from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession

BASE_URL = os.environ.get("HERANBORSA_BASE_URL", "https://heranborsa.arvia.site").rstrip("/")
AGENT_TOKEN = os.environ.get("COMMAND_AGENT_TOKEN", "")
MASTER_KEY = os.environ.get("TELEFLOW_MASTER_KEY", "")
DATA_DIR = Path(os.environ.get("TELEFLOW_DATA_DIR", Path.home() / "Library/Application Support/TeleflowAgent/data"))
CONFIG_FILE = DATA_DIR / "telegram.enc"
POLL_SECONDS = max(2, min(30, int(os.environ.get("COMMAND_POLL_SECONDS", "3"))))
LOCK_FILE = Path(os.environ.get("HERANBORSA_AGENT_LOCK", "/tmp/heranborsa-command-agent.lock"))

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("heranborsa-agent")

PROGRESS_MARKERS = (
    "alınıyor", "aliniyor", "hazırlanıyor", "hazirlaniyor", "işleniyor", "isleniyor",
    "yükleniyor", "yukleniyor", "bekleyin", "lütfen bekle", "lutfen bekle",
)


def is_progress_message(message: Any) -> bool:
    text = (getattr(message, "raw_text", "") or "").lower()
    return not getattr(message, "media", None) and any(marker in text for marker in PROGRESS_MARKERS)


def validate_environment() -> None:
    if not AGENT_TOKEN or not MASTER_KEY:
        raise RuntimeError("COMMAND_AGENT_TOKEN ve TELEFLOW_MASTER_KEY ayarlanmalı.")
    if not CONFIG_FILE.is_file():
        raise RuntimeError(f"Şifreli Telegram oturumu bulunamadı: {CONFIG_FILE}")


def load_telegram_config() -> dict[str, Any]:
    payload = Fernet(MASTER_KEY.encode()).decrypt(CONFIG_FILE.read_bytes())
    config = json.loads(payload.decode())
    if config.get("phase") != "authorized" or not config.get("session"):
        raise RuntimeError("Telegram kullanıcı oturumu yetkilendirilmemiş.")
    return config


def telegram_client(config: dict[str, Any]) -> TelegramClient:
    return TelegramClient(StringSession(config["session"]), int(config["api_id"]), config["api_hash"])


class CloudQueue:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(
            base_url=BASE_URL,
            headers={"authorization": f"Bearer {AGENT_TOKEN}", "user-agent": "HeranBorsa-Mac-Agent/1.0"},
            timeout=httpx.Timeout(35, connect=15),
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def claim(self) -> dict[str, Any] | None:
        response = await self.client.post("/api/commands/agent/claim")
        if response.status_code == 204:
            return None
        response.raise_for_status()
        return response.json()

    async def upload(self, job_id: str, lease: str, path: Path) -> dict[str, str]:
        content_type = "application/octet-stream"
        suffix = path.suffix.lower()
        if suffix in {".jpg", ".jpeg"}: content_type = "image/jpeg"
        elif suffix == ".png": content_type = "image/png"
        elif suffix == ".pdf": content_type = "application/pdf"
        with path.open("rb") as handle:
            response = await self.client.post(
                f"/api/commands/agent/{job_id}/media",
                params={"filename": path.name},
                headers={"x-command-lease": lease, "content-type": content_type},
                content=handle.read(),
            )
        response.raise_for_status()
        return response.json()

    async def complete(self, job_id: str, lease: str, results: list[dict[str, Any]], error: str | None = None) -> None:
        response = await self.client.post(
            f"/api/commands/agent/{job_id}/complete",
            json={"leaseToken": lease, "status": "failed" if error else "completed", "error": error, "results": results},
        )
        response.raise_for_status()

    async def renew(self, job_id: str, lease: str) -> None:
        response = await self.client.post(f"/api/commands/agent/{job_id}/renew", json={"leaseToken": lease})
        response.raise_for_status()


async def wait_for_final_message(client: TelegramClient, message: Any, bot_username: str) -> Any:
    refreshed = await client.get_messages(message.chat_id, ids=message.id)
    if refreshed:
        message = refreshed
    if not is_progress_message(message):
        # Bots may edit an apparently complete answer shortly after sending it.
        await asyncio.sleep(2)
        refreshed = await client.get_messages(message.chat_id, ids=message.id)
        if refreshed:
            message = refreshed
        return message
    for _ in range(45):
        await asyncio.sleep(2)
        refreshed = await client.get_messages(message.chat_id, ids=message.id)
        if refreshed:
            message = refreshed
            if not is_progress_message(message):
                return message
        recent = await client.get_messages(bot_username, limit=10)
        for candidate in sorted(recent or [], key=lambda item: item.id):
            if candidate.id >= message.id and not candidate.out and not is_progress_message(candidate):
                return candidate
    return message


async def serialize_response(client: TelegramClient, queue: CloudQueue, job_id: str, lease: str, response: Any, bot_username: str, command: str, index: int) -> dict[str, Any]:
    result: dict[str, Any] = {
        "stepIndex": index,
        "botUsername": bot_username,
        "command": command,
        "text": response.raw_text or "",
        "kind": "text",
        "mediaKey": None,
        "fileName": None,
    }
    if response.media:
        with tempfile.TemporaryDirectory(prefix="heranborsa-") as directory:
            downloaded = await client.download_media(response, file=directory)
            if downloaded:
                path = Path(downloaded)
                uploaded = await queue.upload(job_id, lease, path)
                result.update({
                    "kind": "image" if response.photo else "file",
                    "mediaKey": uploaded["mediaKey"],
                    "fileName": uploaded["fileName"],
                })
    return result


async def run_step(client: TelegramClient, queue: CloudQueue, job_id: str, lease: str, step: dict[str, Any], index: int) -> list[dict[str, Any]]:
    bot_username = str(step["botUsername"])
    command = str(step["command"])
    while True:
        try:
            async with client.conversation(bot_username, timeout=120) as conversation:
                await conversation.send_message(command)
                response = await conversation.get_response()
                response = await wait_for_final_message(client, response, bot_username)
                messages = [response]
                seen_ids = {response.id}
                # Some analysis bots return an album or several documents. Keep
                # consuming until the conversation is quiet for two seconds.
                for _ in range(11):
                    try:
                        candidate = await asyncio.wait_for(conversation.get_response(), timeout=2)
                    except asyncio.TimeoutError:
                        break
                    if candidate.id not in seen_ids:
                        messages.append(candidate)
                        seen_ids.add(candidate.id)
                # Read every message once more so edited Telegram messages are
                # persisted in their final form, not in their first placeholder form.
                refreshed_messages = []
                for item in messages:
                    refreshed = await client.get_messages(item.chat_id, ids=item.id)
                    refreshed_messages.append(refreshed or item)
                messages = refreshed_messages
                final_messages = [item for item in messages if not is_progress_message(item)]
                if final_messages:
                    messages = final_messages
            break
        except FloodWaitError as error:
            log.warning("Telegram FLOOD_WAIT: %s saniye", error.seconds)
            await asyncio.sleep(error.seconds + 1)
    return [await serialize_response(client, queue, job_id, lease, item, bot_username, command, index) for item in messages]


async def execute_job(client: TelegramClient, queue: CloudQueue, payload: dict[str, Any]) -> None:
    job, lease = payload["job"], payload["leaseToken"]
    results: list[dict[str, Any]] = []
    try:
        log.info("İş başladı: %s (%s komut)", job["id"], len(job["steps"]))
        for index, step in enumerate(job["steps"]):
            await queue.renew(job["id"], lease)
            results.extend(await run_step(client, queue, job["id"], lease, step, index))
            if index < len(job["steps"]) - 1:
                await asyncio.sleep(max(1, min(30, int(step.get("delaySeconds", 4)))))
        await queue.complete(job["id"], lease, results)
        log.info("İş tamamlandı: %s", job["id"])
    except Exception as error:
        log.exception("İş başarısız: %s", job["id"])
        try:
            await queue.complete(job["id"], lease, results, str(error)[:900])
        except Exception:
            log.exception("Hata sonucu Cloudflare'a bildirilemedi")


async def main() -> None:
    validate_environment()
    config = load_telegram_config()
    client = telegram_client(config)
    queue = CloudQueue()
    backoff = POLL_SECONDS
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError("Telegram kullanıcı oturumu geçersiz; Teleflow oturumunu yeniden doğrulayın.")
    log.info("Heran Borsa komut ajanı hazır.")
    try:
        while True:
            try:
                payload = await queue.claim()
                backoff = POLL_SECONDS
                if payload:
                    await execute_job(client, queue, payload)
                else:
                    await asyncio.sleep(POLL_SECONDS)
            except (httpx.HTTPError, OSError) as error:
                log.warning("Cloudflare bağlantısı bekleniyor: %s", type(error).__name__)
                await asyncio.sleep(backoff)
                backoff = min(60, backoff * 2)
    finally:
        await queue.close()
        await client.disconnect()


if __name__ == "__main__":
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Heran Borsa komut ajanı zaten çalışıyor.")
        asyncio.run(main())
