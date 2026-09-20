import { describe, expect, it } from "vitest";
import { isImportantPublicDisclosure, parsePublicKapPage } from "../src/kap/public";

describe("parsePublicKapPage", () => {
  it("extracts the public KAP metadata and normalizes Istanbul time", () => {
    const html = String.raw`<script>"disclosureBasic":{\"title\":\"Özel Durum Açıklaması\",\"companyTitle\":\"Test A.Ş.\",\"stockCode\":\"TEST\",\"relatedStocks\":[{\"code\":\"TST2\"}],\"disclosureClass\":\"ODA\",\"disclosureType\":\"CA\",\"publishDate\":\"2026.09.20 10:00:00\",\"disclosureIndex\":1665625},"disclosureDetail"</script>`;
    expect(parsePublicKapPage(html, 1665625)).toMatchObject({
      id: 1665625,
      codes: ["TST2", "TEST"],
      publishedAt: "2026-09-20T07:00:00.000Z",
    });
  });

  it("keeps fund and portfolio disclosures even without an equity ticker", () => {
    expect(isImportantPublicDisclosure({
      id: 1,
      title: "Yatırım Fonu Sürekli Bilgilendirme Formu",
      company: "Örnek Portföy Yönetimi A.Ş.",
      codes: [],
      disclosureClass: "FON",
      disclosureType: "",
      publishedAt: "2026-09-20T10:00:00.000Z",
      url: "https://www.kap.org.tr/tr/Bildirim/1",
    })).toBe(true);
  });
});
