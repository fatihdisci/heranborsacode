import { normalizeTitle } from '../utils/text';
export interface NewsIdentity { title: string; summary: string; }
function canonical(value: string): string {
  return normalizeTitle(value).replace(/[“”"‘’']/g, '').replace(/[.!?]+$/g, '').trim();
}
// Similar words do not prove the same event; preserve changed numbers/decisions.
export function duplicateNews(a: NewsIdentity, b: NewsIdentity): boolean {
  return canonical(a.title) === canonical(b.title) && canonical(a.summary) === canonical(b.summary);
}
export function newsFingerprint(item: NewsIdentity): string {
  return `${canonical(item.title)}\n${canonical(item.summary)}`;
}
