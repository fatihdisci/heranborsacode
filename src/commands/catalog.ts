export interface CommandDefinition {
  id: string;
  label: string;
  pattern: string;
  needsSymbol: boolean;
}

export interface BotDefinition {
  username: string;
  label: string;
  commands: CommandDefinition[];
}

export const COMMAND_BOTS: BotDefinition[] = [
  {
    username: "b0pt_bot",
    label: "B0PT",
    commands: [
      ["derinlik", "Piyasa derinliği", "/derinlik {HISSE}", true],
      ["akd", "Aracı kurum dağılımı", "/akd {HISSE}", true],
      ["islem", "Anlık işlemler", "/islem {HISSE}", true],
      ["teorik", "Teorik eşleşme", "/teorik {HISSE}", true],
      ["teorikyd", "Yurt dışı teorik", "/teorikyd {HISSE}", true],
      ["takas", "Takas analizi", "/takas {HISSE}", true],
      ["grafik", "Teknik grafik", "/grafik {HISSE}", true],
      ["sirketkarti", "Şirket kartı", "/sirketkarti {HISSE}", true],
      ["detay", "Hisse detayları", "/detay {HISSE}", true],
      ["tum", "Toplu analiz", "/tum {HISSE}", true],
      ["piyasayd", "Dünya piyasaları", "/piyasayd", false],
      ["doviz", "Döviz", "/doviz", false],
      ["halkaarz", "Halka arz", "/halkaarz", false],
      ["viop", "VİOP", "/viop", false],
      ["teminat", "Teminat", "/teminat", false],
      ["bulten", "Bülten", "/bulten", false],
      ["tlref", "TLREF", "/tlref", false],
      ["cds", "CDS", "/cds", false],
    ].map(([id, label, pattern, needsSymbol]) => ({ id: String(id), label: String(label), pattern: String(pattern), needsSymbol: Boolean(needsSymbol) })),
  },
  { username: "ucretsizderinlikbot", label: "Ücretsiz Derinlik", commands: [] },
  { username: "hisseyorumbot", label: "Hisse Yorum", commands: [] },
];

export const ALLOWED_COMMAND_BOTS = new Set(COMMAND_BOTS.map(bot => bot.username));

export interface CommandStep { botUsername: string; command: string; delaySeconds?: number; }

export function validateSteps(value: unknown): CommandStep[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 80) return null;
  const steps: CommandStep[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const candidate = raw as Record<string, unknown>;
    const botUsername = String(candidate.botUsername ?? "").trim().replace(/^@/, "").toLowerCase();
    const command = String(candidate.command ?? "").trim();
    const delaySeconds = Math.max(1, Math.min(30, Number(candidate.delaySeconds ?? 4) || 4));
    if (!ALLOWED_COMMAND_BOTS.has(botUsername) || !command.startsWith("/") || command.length > 160 || /[\r\n]/.test(command)) return null;
    steps.push({ botUsername, command, delaySeconds });
  }
  return steps;
}
