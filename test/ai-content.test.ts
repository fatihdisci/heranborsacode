import { describe, expect, it } from "vitest";
import { extractAttachments, extractReadableContent } from "../src/ai/content";

describe("AI source preparation", () => {
  it("prefers article JSON-LD text and keeps readable page text", () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"NewsArticle","headline":"Fon haberi","articleBody":"Portföy yönetim şirketi yeni fon kurdu."}</script><style>.x{}</style></head><body><nav>Menü</nav><article>Detaylı açıklama yüzde 12 büyüme içeriyor.</article><script>secret()</script></body></html>`;
    const text = extractReadableContent(html);
    expect(text).toContain("Fon haberi");
    expect(text).toContain("Portföy yönetim şirketi yeni fon kurdu.");
    expect(text).toContain("Detaylı açıklama yüzde 12 büyüme içeriyor.");
    expect(text).not.toContain("secret()");
  });

  it("finds KAP extensionless downloads and ordinary document links", () => {
    const html = `<a href="/tr/api/file/download/abc">Bildirim_Eki.pdf</a><a href="/rapor.xlsx">Rapor</a><a href="/about">Hakkımızda</a>`;
    expect(extractAttachments(html, "https://www.kap.org.tr/tr/Bildirim/1")).toEqual([
      { url: "https://www.kap.org.tr/tr/api/file/download/abc", filename: "Bildirim_Eki.pdf", isPdf: true },
      { url: "https://www.kap.org.tr/rapor.xlsx", filename: "rapor.xlsx", isPdf: false },
    ]);
  });
});
