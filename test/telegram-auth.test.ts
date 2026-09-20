import { describe, expect, it } from "vitest";
import { authorizeTelegramRequest } from "../src/security/telegram";
import type { Env } from "../src/types";

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | string, value: string): Promise<ArrayBuffer> {
  const material = typeof key === "string" ? encoder.encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(token: string): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    signature: "telegram-ed25519-signature",
    user: JSON.stringify({ id: 123456789, first_name: "Fatih", username: "fff12345q" }),
  });
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmac("WebAppData", token);
  params.set("hash", hex(await hmac(secret, checkString)));
  return params.toString();
}

describe("Telegram Mini App authorization", () => {
  it("accepts current initData with signature for the allowed username", async () => {
    const token = "123456789:test-token";
    const request = new Request("https://example.test/api/tweet-draft", { headers: { "x-telegram-init-data": await signedInitData(token) } });
    const env = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-100123", TELEGRAM_ALLOWED_USERNAME: "fff12345q" } as Env;
    await expect(authorizeTelegramRequest(request, env)).resolves.toBe(true);
  });

  it("rejects a different Telegram username", async () => {
    const token = "123456789:test-token";
    const request = new Request("https://example.test/api/tweet-draft", { headers: { "x-telegram-init-data": await signedInitData(token) } });
    const env = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-100123", TELEGRAM_ALLOWED_USERNAME: "someone-else" } as Env;
    await expect(authorizeTelegramRequest(request, env)).resolves.toBe(false);
  });
});
