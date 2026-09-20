import { describe, expect, it } from "vitest";
import { parsePublicKapPage } from "../src/kap/public";

describe("parsePublicKapPage", () => {
  it("extracts the public KAP metadata and normalizes Istanbul time", () => {
    const html = String.raw`<script>"disclosureBasic":{\"title\":\"Özel Durum Açıklaması\",\"companyTitle\":\"Test A.Ş.\",\"stockCode\":\"TEST\",\"relatedStocks\":[{\"code\":\"TST2\"}],\"disclosureClass\":\"ODA\",\"disclosureType\":\"CA\",\"publishDate\":\"2026.09.20 10:00:00\",\"disclosureIndex\":1665625},"disclosureDetail"</script>`;
    expect(parsePublicKapPage(html, 1665625)).toMatchObject({
      id: 1665625,
      codes: ["TST2", "TEST"],
      publishedAt: "2026-09-20T07:00:00.000Z",
    });
  });
});
