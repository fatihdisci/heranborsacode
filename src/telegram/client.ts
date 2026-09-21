import type { Env } from "../types";
import { fetchWithTimeout } from "../utils/http";

export class TelegramError extends Error {
  constructor(public status: number, public retryAfter = 0) {
    super(`Telegram HTTP ${status}`);
  }
}

function configured(env: Env): boolean { return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID); }

export async function telegramCall<T = unknown>(env: Env, method: string, body: FormData | URLSearchParams): Promise<T> {
  if (!configured(env)) throw new Error("Telegram secrets are not configured");
  let response: Response;
  try { response = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body }); }
  catch { throw new Error("Telegram network error or timeout (delivery uncertain)"); }
  const result = await response.json<{ ok: boolean; error_code?: number; result?: T; parameters?: { retry_after?: number } }>().catch(() => null);
  if (!response.ok || !result?.ok) throw new TelegramError(result?.error_code ?? response.status, result?.parameters?.retry_after ?? 0);
  return result.result as T;
}

export type InlineButton = { text: string; url: string } | { text: string; callback_data: string } | { text: string; web_app: { url: string } };
export interface MessageOptions { keyboard?: InlineButton[][]; replyTo?: number; }

export async function sendMessage(env: Env, html: string, button?: { text: string; url: string }, options: MessageOptions = {}): Promise<number> {
  const form = new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID!, text: html, parse_mode: "HTML", disable_web_page_preview: "true" });
  if (button) form.set("reply_markup", JSON.stringify({ inline_keyboard: [[{ text: button.text, url: button.url }]] }));
  if (options.keyboard) form.set('reply_markup',JSON.stringify({inline_keyboard:options.keyboard}));
  if (options.replyTo) form.set('reply_parameters',JSON.stringify({message_id:options.replyTo,allow_sending_without_reply:true}));
  return (await telegramCall<{message_id:number}>(env, "sendMessage", form)).message_id;
}

export async function sendDocument(env: Env, pdfUrl: string, filename: string): Promise<number> {
  const form = new FormData();
  form.set("chat_id", env.TELEGRAM_CHAT_ID!);
  form.set("document", pdfUrl);
  form.set("caption", filename);
  return (await telegramCall<{message_id:number}>(env, "sendDocument", form)).message_id;
}
