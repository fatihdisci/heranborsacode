import type { Env } from "../types";

export async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM system_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO system_state(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").bind(key, value).run();
}

export async function financeNotificationCutoff(env: Env): Promise<number | null> {
  const value = await getState(env, 'finance_notification_cutoff_at');
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

export function publishedSince(value: string | null, cutoff: number | null): boolean {
  if (cutoff === null) return true;
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time >= cutoff;
}

// RSS mirrors and X scrapers can surface an old post as a new item. Keep it in
// the Mini App history, but do not wake the user long after publication.
export const NEWS_ALERT_MAX_AGE_MS = 30 * 60_000;
export function recentNewsForTelegram(value: string | null, now = Date.now()): boolean {
  const published = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(published) && published >= now - NEWS_ALERT_MAX_AGE_MS && published <= now + 60_000;
}
