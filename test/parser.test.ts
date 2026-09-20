import { describe, expect, it } from "vitest";
import { parseRss } from "../src/rss/parser";
import { parseBulletins } from "../src/spk/poll";
import { normalizeKapList } from "../src/kap/poll";

describe("source parsers", () => {
  it("parses RSS and Atom item links", () => {
    expect(parseRss("<rss><channel><item><title><![CDATA[Test &amp; Başlık]]></title><description>Özet metni</description><link>https://example.com/a?utm_source=x</link><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>")).toEqual([{ title: "Test & Başlık", description: "Özet metni", url: "https://example.com/a?utm_source=x", publishedAt: "2026-09-01T10:00:00.000Z" }]);
  });
  it("decodes hexadecimal XML entities used by RSS dates and titles", () => {
    expect(parseRss("<rss><channel><item><title>Şirket&#x27;ten yatırım</title><link>https://example.com/b</link><pubDate>Sun, 20 Sep 2026 13:31:00 &#x2B;0300</pubDate></item></channel></rss>")).toEqual([
      { title: "Şirket'ten yatırım", description: null, url: "https://example.com/b", publishedAt: "2026-09-20T10:31:00.000Z" }
    ]);
  });
  it("recognizes SPK bulletin PDF links", () => {
    const parsed = parseBulletins('<a href="/files/62.pdf"><div>Bülten No : 2026/62</div><div>Yayımlanma : 18 Eylül 2026 Cuma</div></a>', "https://spk.gov.tr/list");
    expect(parsed).toEqual([{ number: "2026/62", date: "18.09.2026", pdfUrl: "https://spk.gov.tr/files/62.pdf" }]);
  });
  it("normalizes KAP Data Dissemination list responses", () => {
    expect(normalizeKapList([{ disclosureIndex: "42", title: "Bildirim", disclosureType: "FR", disclosureClass: "ODA" }])[0]).toMatchObject({ disclosureIndex: "42", disclosureType: "FR", disclosureClass: "ODA" });
  });
});
