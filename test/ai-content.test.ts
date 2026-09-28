import { describe, expect, it } from "vitest";
import { extractAttachments, extractReadableContent } from "../src/ai/content";

describe("AI source preparation", () => {
  it("isolates article text from unrelated structured data and navigation", () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"NewsArticle","headline":"Fon haberi","articleBody":"Portföy yönetim şirketi yeni fon kurdu."}</script><style>.x{}</style></head><body><nav>Menü</nav><article>Detaylı açıklama yüzde 12 büyüme içeriyor.</article><script>secret()</script></body></html>`;
    const text = extractReadableContent(html);
    expect(text).not.toContain("Fon haberi");
    expect(text).not.toContain("Portföy yönetim şirketi yeni fon kurdu.");
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

import { extractArticleSource } from '../src/ai/source-extract';
it('rejects title-only pages and ambiguous articles', () => {
  expect(()=>extractReadableContent('<h1>Şirket büyük sözleşme imzaladı</h1><nav>Menü</nav>')).toThrow('ana metni');
  expect(()=>extractReadableContent('<article>Birinci şirket sözleşme imzaladı.</article><article>İkinci şirket kredi kullandı.</article>')).toThrow('ana metni');
});
it('selects only matching structured article evidence', () => {
  const html='<script type="application/ld+json">'+JSON.stringify({'@graph':[
    {'@type':'NewsArticle',url:'https://example.com/target',articleBody:'Şirket kredi limiti için başvurdu.'},
    {'@type':'NewsArticle',url:'https://example.com/other',articleBody:'Başka şirket kredi kullandı.'},
  ]})+'</script>';
  const source=extractArticleSource(html,{type:'news',url:'https://example.com/target',title:'Kredi limiti'});
  expect(source.text).toContain('başvurdu');expect(source.text).not.toContain('kullandı');
});
it('preserves financial table headings and merged cells and excludes unrelated downloads', () => {
  const source=extractArticleSource('<a href="/other.pdf">Başka haber.pdf</a><div class="disclosureScrollableArea"><p>Finansal sonuçlar (bin TL)</p><table><tr><th colspan="2">2026 ilk yarı</th></tr><tr><td>Net kâr</td><td>1.250</td></tr></table><a href="/target.pdf">Sonuçlar.pdf</a></div>',{type:'kap',title:'Sonuçlar',url:'https://example.com/target'});
  expect(source.text).toContain('bin TL');expect(source.text).toContain('"colSpan":2');expect(source.text).toContain('2026 ilk yarı');
  expect(extractAttachments(source.html,'https://example.com/target').map(a=>a.url)).toEqual(['https://example.com/target.pdf']);
});
