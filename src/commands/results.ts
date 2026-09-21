export interface CommandResultRow {
  step_index: number;
  bot_username: string;
  command: string;
  response_text: string | null;
  response_kind: string;
  media_key: string | null;
  file_name: string | null;
  created_at: string;
  [key: string]: unknown;
}

const PROGRESS_MARKERS = [
  "alınıyor", "aliniyor", "hazırlanıyor", "hazirlaniyor", "işleniyor", "isleniyor",
  "yükleniyor", "yukleniyor", "bekleyin", "lütfen bekle", "lutfen bekle",
];

export function isProgressResponse(text: unknown): boolean {
  const normalized = String(text ?? "").toLocaleLowerCase("tr-TR");
  return PROGRESS_MARKERS.some(marker => normalized.includes(marker));
}

export function finalCommandResults(rows: CommandResultRow[]): CommandResultRow[] {
  const finalSteps = new Set<number>();
  for (const row of rows) {
    if (row.media_key || !isProgressResponse(row.response_text)) finalSteps.add(Number(row.step_index));
  }
  return rows.filter(row => !finalSteps.has(Number(row.step_index)) || row.media_key || !isProgressResponse(row.response_text));
}

export function commandMediaUrl(mediaKey: string | null): string | null {
  if (!mediaKey) return null;
  return `/api/commands/media/${mediaKey.split("/").map(encodeURIComponent).join("/")}`;
}
