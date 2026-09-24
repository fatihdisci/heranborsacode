export interface ResetItem { id:string; resetType:string; announcedAt:string; text:string; url:string; }
export function parseResets(value: unknown): ResetItem[] {
  const rows = (value as {data?:unknown} | null)?.data;
  if (!Array.isArray(rows)) throw new Error('Invalid Codex Resets response');
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const r = row as Record<string,unknown>;
    const source = r.source as Record<string,unknown> | undefined;
    if (typeof r.id !== 'string' || !/^[\w-]{1,100}$/.test(r.id) || typeof r.announced_at !== 'string' || Number.isNaN(Date.parse(r.announced_at)) || typeof r.text !== 'string') return [];
    const url = typeof source?.url === 'string' && /^https:\/\//.test(source.url) ? source.url : 'https://codex-resets.com/';
    return [{id:r.id,resetType:typeof r.reset_type === 'string' ? r.reset_type : 'regular',announcedAt:r.announced_at,text:r.text.slice(0,1500),url}];
  });
}
