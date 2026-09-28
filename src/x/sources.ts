export const X_ACCOUNTS = ['haskologlu', 'ismailsaymaz'] as const;
export const X_POLL_INTERVAL_MS = 3 * 60_000;
export function isTrackedAccount(value: string): boolean {
  return (X_ACCOUNTS as readonly string[]).includes(value.toLowerCase());
}
