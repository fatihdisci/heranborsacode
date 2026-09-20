import type { Env } from "../types";

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | string, value: string): Promise<ArrayBuffer> {
  const material: ArrayBuffer = typeof key === "string" ? encoder.encode(key).buffer as ArrayBuffer : key;
  const cryptoKey = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function authorizeTelegramRequest(request: Request, env: Env): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const raw = request.headers.get("x-telegram-init-data");
  if (!raw) return false;
  const params = new URLSearchParams(raw);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!receivedHash || !Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 24 * 60 * 60) return false;
  params.delete("hash");
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmac("WebAppData", env.TELEGRAM_BOT_TOKEN);
  const expectedHash = hex(await hmac(secret, checkString));
  if (!constantTimeEqual(expectedHash, receivedHash.toLowerCase())) return false;
  try {
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number; username?: string };
    const allowedUsername = env.TELEGRAM_ALLOWED_USERNAME?.trim().replace(/^@/, "").toLowerCase();
    if (allowedUsername) return user.username?.toLowerCase() === allowedUsername;
    return String(user.id ?? "") === env.TELEGRAM_CHAT_ID;
  } catch {
    return false;
  }
}
