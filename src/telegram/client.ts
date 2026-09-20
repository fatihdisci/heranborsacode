import type { Env } from "../types";
import { fetchWithTimeout, retry } from "../utils/http";

function configured(env: Env): boolean { return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID); }

async function call(env: Env, method: string, body: FormData | URLSearchParams): Promise<void> {
  if (!configured(env)) throw new Error("Telegram secrets are not configured");
  const response = await retry(() => fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body }), 3);
  if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
  const result = await response.json<{ ok: boolean; description?: string }>();
  if (!result.ok) throw new Error(`Telegram ${method} failed: ${result.description ?? "unknown error"}`);
}

export async function sendMessage(env: Env, html: string, button?: { text: string; url: string }): Promise<void> {
  const form = new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID!, text: html, parse_mode: "HTML", disable_web_page_preview: "true" });
  if (button) form.set("reply_markup", JSON.stringify({ inline_keyboard: [[{ text: button.text, url: button.url }]] }));
  await call(env, "sendMessage", form);
}

export async function sendDocument(env: Env, pdfUrl: string, filename: string): Promise<void> {
  const form = new FormData();
  form.set("chat_id", env.TELEGRAM_CHAT_ID!);
  form.set("document", pdfUrl);
  form.set("caption", filename);
  await call(env, "sendDocument", form);
}

