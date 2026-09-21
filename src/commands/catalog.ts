export type CommandArgumentKind = "none" | "symbol" | "text";

export interface CommandDefinition {
  id: string;
  label: string;
  pattern: string;
  needsSymbol: boolean;
  argumentKind: CommandArgumentKind;
  argumentLabel?: string;
  placeholder?: string;
}

export interface BotDefinition {
  username: string;
  label: string;
  commands: CommandDefinition[];
}

function command(id: string, label: string, argumentKind: CommandArgumentKind = "none", placeholder?: string): CommandDefinition {
  const token = argumentKind === "symbol" ? "{HISSE}" : argumentKind === "text" ? "{ARGUMAN}" : "";
  return {
    id,
    label,
    pattern: `/${id}${token ? ` ${token}` : ""}`,
    needsSymbol: argumentKind === "symbol",
    argumentKind,
    argumentLabel: argumentKind === "symbol" ? "Hisse seç" : argumentKind === "text" ? "Kurum / parametre" : undefined,
    placeholder,
  };
}

export const COMMAND_BOTS: BotDefinition[] = [
  {
    username: "b0pt_bot",
    label: "B0PT",
    commands: [
      command("derinlik", "Piyasa Derinliği (25 kademe)", "symbol", "Kod ara: THYAO"),
      command("akd", "Aracı Kurum Dağılımı (10 kademe)", "symbol", "Kod ara: THYAO"),
      command("teorik", "Teorik Eşleşme Ekranı", "symbol", "Kod ara: THYAO"),
      command("islem", "Anlık İşlemler", "symbol", "Kod ara: THYAO"),
      command("tumu", "Komut Analiz Modülleri", "symbol", "Kod ara: THYAO"),
      command("takas", "Takas Analizi (Anlık ve Tarihsel)", "symbol", "Kod ara: THYAO"),
      command("kademe", "Anlık Kademe Görünümü", "symbol", "Kod ara: THYAO"),
      command("grafik", "Destek/Direnç Seviyeleri", "symbol", "Kod ara: THYAO"),
      command("menu", "Hızlı Komut Menüsü"),
      command("genelakd", "Genel Kurum Dağılımı"),
      command("kurum", "Kurum İşlemleri", "text", "Örn. bank of america"),
      command("viop", "Anlık VİOP Verileri"),
      command("bilanco", "Son Bilanço Verisi", "symbol", "Kod ara: THYAO"),
      command("detay", "Hisse Detayları", "symbol", "Kod ara: THYAO"),
      command("teorikyd", "Teorik Eşleşme Değişimi"),
      command("piyasayd", "Günlük Yükselen/Düşenler"),
      command("sirketkarti", "Şirket Bilgi Kartı", "symbol", "Kod ara: THYAO"),
      command("halkaarz", "Yeni Halka Arzlar"),
      command("doviz", "Döviz, Altın ve Endeksler"),
      command("grup", "Resmî B0PT Hisse Grupları"),
      command("bofa", "BofA Analizi"),
      command("bulten", "Günlük Bülten"),
      command("teminat", "VİOP Teminat Tamamlama"),
      command("ytakas", "Yabancı Takas Oranı", "symbol", "Kod ara: THYAO"),
      command("tlref", "Gecelik Faiz Oranı"),
      command("vbts", "Volatilite Bazlı Tedbir Sistemi", "symbol", "Kod ara: THYAO"),
      command("vbtstum", "Tüm VBTS'ler"),
    ],
  },
  {
    username: "ucretsizderinlikbot",
    label: "Ücretsiz Derinlik",
    commands: [
      command("derinlik", "Piyasa Derinliği", "symbol", "Kod ara: THYAO"),
      command("akd", "Aracı Kurum Dağılımı", "symbol", "Kod ara: THYAO"),
      command("takas", "Takas Analizi", "symbol", "Kod ara: THYAO"),
      command("teorik", "Teorik Eşleşme", "symbol", "Kod ara: THYAO"),
      command("kurum", "Kurum İşlemleri", "text", "Örn. bank of america"),
    ],
  },
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
    const commandText = String(candidate.command ?? "").trim();
    const delaySeconds = Math.max(1, Math.min(30, Number(candidate.delaySeconds ?? 4) || 4));
    if (!ALLOWED_COMMAND_BOTS.has(botUsername) || !commandText.startsWith("/") || commandText.length > 160 || /[\r\n]/.test(commandText)) return null;
    steps.push({ botUsername, command: commandText, delaySeconds });
  }
  return steps;
}
