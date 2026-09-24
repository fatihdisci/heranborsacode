import type { Env } from './types';

export const BRAND = { name: 'Vibe Radar', slug: 'vibe-radar', subtitle: 'AI akışı' } as const;

const DEFAULT_PUBLIC_BASE_URL = 'https://borsa.discilaw.com';

export function publicBaseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}
