import type { Env } from "../types";
import { fetchWithTimeout } from "../utils/http";

export const RESULTS_SCOPE = "command-results:read";
export const COMMAND_RUN_SCOPE = "command-jobs:run";
export const RESULTS_MCP_PATH = "/api/command-results/mcp";

function httpsUrl(value: string | undefined): URL | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

export function readerConfig(env: Env) {
  const base = httpsUrl(env.PUBLIC_BASE_URL), issuer = httpsUrl(env.RESULTS_OAUTH_ISSUER);
  const jwks = httpsUrl(env.RESULTS_OAUTH_JWKS_URL);
  const subject = env.RESULTS_OAUTH_SUBJECT;
  if (env.RESULTS_READ_ENABLED !== "true" || !base || base.pathname !== "/" || !issuer || !jwks || !subject?.trim()) return null;
  return { origin: base.origin, resource: base.origin + RESULTS_MCP_PATH, issuer: env.RESULTS_OAUTH_ISSUER!, jwks: jwks.href, subject };
}

type SigningKey = JsonWebKey & { kid?: string };
// Fixed, operator-configured JWKS only. Never follow token-controlled jku/x5u URLs.
let keyCache: { url: string; until: number; keys: SigningKey[] } | undefined;
async function signingKeys(url: string, now: number): Promise<SigningKey[]> {
  if (keyCache?.url === url && keyCache.until > now) return keyCache.keys;
  // Workerd rejects redirect:"error". Manual preserves the no-redirect boundary;
  // the non-2xx check below rejects redirects without contacting their target.
  const response = await fetchWithTimeout(url, { redirect: "manual", headers: { accept: "application/json" } }, 5000);
  if (!response.ok || Number(response.headers.get("content-length")) > 100_000) throw new Error("jwks_unavailable");
  const raw = await response.text();
  if (raw.length > 100_000) throw new Error("jwks_unavailable");
  const value = JSON.parse(raw) as { keys?: SigningKey[] };
  if (!Array.isArray(value.keys) || value.keys.length > 64) throw new Error("jwks_unavailable");
  const keys = value.keys.filter(key => key.kty === "RSA" && typeof key.kid === "string" &&
    typeof key.n === "string" && typeof key.e === "string" && (!key.use || key.use === "sig") &&
    (!key.alg || key.alg === "RS256") && (!key.key_ops || key.key_ops.includes("verify")));
  keyCache = { url, until: now + 5 * 60_000, keys };
  return keys;
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_token");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
}

export type ReaderAuthorization = "authorized" | "unauthorized" | "unavailable";
export async function authorizeResultsReader(request: Request, env: Env, now = Date.now(), requiredScope = RESULTS_SCOPE): Promise<ReaderAuthorization> {
  const config = readerConfig(env);
  if (!config) return "unavailable";
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || token.length > 16_384) return "unauthorized";
  let header: { alg?: string; kid?: string; crit?: unknown }, claims: Record<string, unknown>, signature: Uint8Array<ArrayBuffer>;
  const parts = token.split(".");
  try {
    if (parts.length !== 3) return "unauthorized";
    header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    signature = decode(parts[2]);
    const seconds = Math.floor(now / 1000);
    if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined ||
      claims.iss !== config.issuer || claims.sub !== config.subject ||
      !(claims.aud === config.resource || (Array.isArray(claims.aud) && claims.aud.includes(config.resource))) ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > seconds)) ||
      (claims.iat !== undefined && (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > seconds + 60)) ||
      typeof claims.scope !== "string" || !claims.scope.split(/\s+/).includes(RESULTS_SCOPE) ||
      !claims.scope.split(/\s+/).includes(requiredScope)) return "unauthorized";
  } catch { return "unauthorized"; }
  let keys: SigningKey[];
  try { keys = await signingKeys(config.jwks, now); }
  catch { return "unavailable"; }
  try {
    const matches = keys.filter(key => key.kid === header.kid);
    if (matches.length !== 1) return "unauthorized";
    const key = await crypto.subtle.importKey("jwk", matches[0], { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!("modulusLength" in key.algorithm) || Number(key.algorithm.modulusLength) < 2048) return "unauthorized";
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(parts[0] + "." + parts[1]))
      ? "authorized" : "unauthorized";
  } catch { return "unauthorized"; }
}

export function readerChallenge(env: Env, requiredScope = RESULTS_SCOPE): string {
  const config = readerConfig(env)!;
  const scope = requiredScope === RESULTS_SCOPE ? RESULTS_SCOPE : `${RESULTS_SCOPE} ${requiredScope}`;
  return `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/api/command-results/mcp", scope="${scope}"`;
}
