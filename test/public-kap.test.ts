import { describe, expect, it } from "vitest";
import { circuitBreakerBody, isImportantPublicDisclosure, parsePublicKapPage } from "../src/kap/public";

describe("parsePublicKapPage", () => {
  it("extracts the public KAP metadata and normalizes Istanbul time", () => {
    const html = String.raw`<script>"disclosureBasic":{\"title\":\"Özel Durum Açıklaması\",\"companyTitle\":\"Test A.Ş.\",\"stockCode\":\"TEST\",\"relatedStocks\":[{\"code\":\"TST2\"}],\"disclosureClass\":\"ODA\",\"disclosureType\":\"CA\",\"publishDate\":\"2026.09.20 10:00:00\",\"disclosureIndex\":1665625},"disclosureDetail"</script>`;
    expect(parsePublicKapPage(html, 1665625)).toMatchObject({
      id: 1665625,
      codes: ["TST2", "TEST"],
      summary: null,
      resumeAt: null,
      publishedAt: "2026-09-20T07:00:00.000Z",
    });
  });

  it("parses DKB string symbols and formats the circuit-breaker continuation time", () => {
    const html = String.raw`<script>"disclosureBasic":{\"title\":\"Pay Bazında Devre Kesici Bildirimi\",\"companyTitle\":\"BORSA İSTANBUL BISTECH DEVRE KESİCİ UYGULAMASI\",\"stockCode\":null,\"relatedStocks\":\"EKIM\",\"disclosureClass\":\"DUY\",\"disclosureType\":\"DUY\",\"publishDate\":\"2026.09.18 12:33:00\",\"disclosureIndex\":1665207,\"summary\":\"EKIM.E işlem sırasında Pay Bazında Devre Kesici Uygulaması devreye girmiştir\"},"disclosureDetail"</script><p>Emir toplama bölümünü takiben yapılacak eşleştirme sonrasında işlemlere 12:44:59 itibarıyla devam edilecektir.</p>`;
    const item = parsePublicKapPage(html, 1665207);
    expect(item).toMatchObject({ codes: ["EKIM"], resumeAt: "12:44:59" });
    expect(item && circuitBreakerBody(item)).toBe("Hissede devre kesici uygulandı.\nİşlemler emir toplama aşamasının ardından saat 12:44:59 itibarıyla devam edecek.");
  });

  it("keeps fund and portfolio disclosures even without an equity ticker", () => {
    expect(isImportantPublicDisclosure({
      id: 1,
      title: "Yatırım Fonu Sürekli Bilgilendirme Formu",
      company: "Örnek Portföy Yönetimi A.Ş.",
      codes: [],
      disclosureClass: "FON",
      disclosureType: "",
      summary: null,
      resumeAt: null,
      publishedAt: "2026-09-20T10:00:00.000Z",
      url: "https://www.kap.org.tr/tr/Bildirim/1",
    })).toBe(true);
  });

  it("does not turn a portfolio manager institution code into a stock hashtag", () => {
    const html = String.raw`<script>"disclosureBasic":{"title":"Genel Açıklama","companyTitle":"TERA PORTFÖY YÖNETİMİ A.Ş.","stockCode":"SKP","relatedStocks":null,"disclosureClass":"DG","disclosureType":"DG","publishDate":"2026.09.20 18:06:04","disclosureIndex":1665627,"summary":"Katılma Payı İşlemleri"},"disclosureDetail"</script>`;
    expect(parsePublicKapPage(html, 1665627)).toMatchObject({ codes: [] });
  });
});
