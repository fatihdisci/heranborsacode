import { describe, expect, it } from "vitest";
import { circuitBreakerBody, circuitBreakerMessage, disclosureSubjectCodes, isImportantPublicDisclosure, parsePublicKapPage, suppressPublicKapNotification } from "../src/kap/public";

it('keeps issuance documents and credit use out of Telegram notifications', () => {
  for (const title of ['İhraç Belgesi', 'Tertip İhraç Belgesi', 'Fon İhraç Sözleşmesi', 'Kredi Kullanımı', 'Fon Gider Bilgileri', 'FON GİDER BİLGİLERİ', 'İç Tüzük', 'FON İÇTÜZÜĞÜ DEĞİŞİKLİĞİ', 'Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faizsiz)', 'Kurumsal Yönetim Bilgi Formu (Güncelleme) - Yönetim Kurulu-2']) {
    expect(suppressPublicKapNotification(title)).toBe(true);
  }
  expect(suppressPublicKapNotification('Yeni kredi sözleşmesi imzalandı')).toBe(false);
});

describe("parsePublicKapPage", () => {
  it("extracts the public KAP metadata and normalizes Istanbul time", () => {
    const html = String.raw`<script>"disclosureBasic":{\"title\":\"Özel Durum Açıklaması\",\"companyTitle\":\"Test A.Ş.\",\"stockCode\":\"TEST\",\"relatedStocks\":[{\"code\":\"TST2\"}],\"disclosureClass\":\"ODA\",\"disclosureType\":\"CA\",\"publishDate\":\"2026.09.20 10:00:00\",\"disclosureIndex\":1665625},"disclosureDetail"</script>`;
    expect(parsePublicKapPage(html, 1665625)).toMatchObject({
      id: 1665625,
      codes: ["TST2", "TEST"],
      issuerCode: "TEST",
      summary: null,
      resumeAt: null,
      publishedAt: "2026-09-20T07:00:00.000Z",
    });
    expect(disclosureSubjectCodes(parsePublicKapPage(html, 1665625)!)).toEqual(["TEST"]);
  });

  it("parses DKB string symbols and formats deterministic copy-ready text", () => {
    const html = String.raw`<script>"disclosureBasic":{\"title\":\"Pay Bazında Devre Kesici Bildirimi\",\"companyTitle\":\"BORSA İSTANBUL BISTECH DEVRE KESİCİ UYGULAMASI\",\"stockCode\":null,\"relatedStocks\":\"EKIM\",\"disclosureClass\":\"DUY\",\"disclosureType\":\"DUY\",\"publishDate\":\"2026.09.18 12:33:00\",\"disclosureIndex\":1665207,\"summary\":\"EKIM.E işlem sırasında Pay Bazında Devre Kesici Uygulaması devreye girmiştir\"},"disclosureDetail"</script><p>Emir toplama bölümünü takiben yapılacak eşleştirme sonrasında işlemlere 12:44:59 itibarıyla devam edilecektir.</p>`;
    const item = parsePublicKapPage(html, 1665207);
    expect(item).toMatchObject({ codes: ["EKIM"], resumeAt: "12:44:59" });
    expect(item && disclosureSubjectCodes(item)).toEqual(["EKIM"]);
    expect(item && circuitBreakerBody(item)).toBe("Devre kesici uygulandı. Sürekli işleme ara verildi.");
  });

  it('does not assign an index to every share in a broad KAP relatedStocks list', () => {
    const html = String.raw`<script>"disclosureBasic":{"title":"BIST Pay Endeksleri Dönemsel Değişiklikleri","companyTitle":"BORSA İSTANBUL A.Ş.","stockCode":null,"relatedStocks":"THYAO,ASELS,ZZZZ","disclosureIndex":1665628},"disclosureDetail"</script>`;
    expect(disclosureSubjectCodes(parsePublicKapPage(html,1665628)!)).toEqual([]);
  });

  it("combines every DKB symbol from the same catch-up cycle", () => {
    const base = {
      id: 1, title: "Pay Bazında Devre Kesici Bildirimi", company: "Borsa İstanbul",
      disclosureClass: "DUY", disclosureType: "DUY", summary: null, resumeAt: null,
      publishedAt: "2026-09-20T10:00:00.000Z", url: "https://www.kap.org.tr/tr/Bildirim/1",
    };
    expect(circuitBreakerMessage([
      { ...base, codes: ["THYAO"] },
      { ...base, id: 2, codes: ["ASELS", "THYAO"] },
    ])).toBe("#THYAO #ASELS\n\nDevre kesici uygulandı. Sürekli işleme ara verildi.");
  });

  it("keeps fund and portfolio disclosures even without an equity ticker", () => {
    expect(isImportantPublicDisclosure({
      id: 1,
      title: "Yatırım Fonu Kuruluşu",
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

  it('keeps portfolio fund defaults as critical while excluding unrelated defaults and muted titles',()=>{
    expect(isImportantPublicDisclosure({title:'Temerrüt İşlemi',company:'TERA PORTFÖY YÖNETİMİ A.Ş.',codes:[]})).toBe(true);
    expect(isImportantPublicDisclosure({title:'Temerrüt İşlemi',company:'Örnek Banka A.Ş.',codes:['THYAO']})).toBe(false);
    expect(isImportantPublicDisclosure({title:'Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faizsiz)',company:'Örnek A.Ş.',codes:['THYAO']})).toBe(false);
    expect(isImportantPublicDisclosure({title:'Kurumsal Yönetim Bilgi Formu (Güncelleme) - Yönetim Kurulu-2',company:'Örnek A.Ş.',codes:['THYAO']})).toBe(false);
  });

  it.each([
    { title: "Portföy Dağılım Raporu", codes: [] },
    { title: "Temerrüt İşlemi", codes: ["YKBNK"] },
    { title: "01285 - Borsa Dışı Vaad Sözleşmesi", codes: [] },
    { title: "Borsa Dışı Repo - Ters Repo Sözleşmesi", codes: [] },
    { title: "Fon Sürekli Bilgilendirme Formu", codes: [] },
    { title: "Yatırım Fonu Sürekli Bilgilendirme Formu", codes: [] },
    { title: "Kredi Derecelendirmesi", codes: ["HEDEF"] },
    { title: "Yatırımcı Bilgi Formu", codes: [] },
  ])("filters $title disclosures", ({ title, codes }) => {
    expect(isImportantPublicDisclosure({
      id: 1,
      title,
      company: "Örnek Kurum A.Ş.",
      codes,
      disclosureClass: "DUY",
      disclosureType: "DUY",
      summary: null,
      resumeAt: null,
      publishedAt: "2026-09-20T10:00:00.000Z",
      url: "https://www.kap.org.tr/tr/Bildirim/1",
    })).toBe(false);
  });

  it("does not turn a portfolio manager institution code into a stock hashtag", () => {
    const html = String.raw`<script>"disclosureBasic":{"title":"Genel Açıklama","companyTitle":"TERA PORTFÖY YÖNETİMİ A.Ş.","stockCode":"SKP","relatedStocks":null,"disclosureClass":"DG","disclosureType":"DG","publishDate":"2026.09.20 18:06:04","disclosureIndex":1665627,"summary":"Katılma Payı İşlemleri"},"disclosureDetail"</script>`;
    expect(parsePublicKapPage(html, 1665627)).toMatchObject({ codes: [] });
  });
});
