import { describe, expect, it } from "vitest";
import { findTickers, isRelevantNews, isTurkishNews } from "../src/rss/filter";

describe("RSS news filters", () => {
  it("keeps Turkish market news", () => {
    expect(isTurkishNews("Borsa İstanbul'da bankacılık hisseleri yükseldi")).toBe(true);
    expect(isRelevantNews("Borsa İstanbul'da bankacılık hisseleri yükseldi")).toBe(true);
  });

  it("rejects English and off-topic headlines", () => {
    expect(isTurkishNews("Russia, Ukraine trade major drone attacks as Moscow oil refinery hit")).toBe(false);
    expect(isRelevantNews("Türkiye'nin tek üç Michelin anahtarlı oteli oldu")).toBe(false);
  });

  it("uses the summary for finance relevance and company ticker matching", () => {
    const title = "İnşaatlarda tuğla yerine pet şişe kullanmaya başladılar";
    const summary = "Şişecam iştiraki ve BIST payları için yeni yatırım gündemde.";
    expect(isTurkishNews(title, summary)).toBe(true);
    expect(isRelevantNews(title, summary)).toBe(true);
    expect(findTickers(title, summary)).toContain("SISE");
  });

  it("keeps fund investigation headlines from the proven filter set", () => {
    expect(isRelevantNews("Fon soruşturmasında MASAK'a yeni inceleme talebi")).toBe(true);
  });

  it("keeps portfolio-management and watched institution news", () => {
    expect(isRelevantNews("Tera Portföy yeni serbest fonunu duyurdu")).toBe(true);
    expect(isRelevantNews("Pusula Finans için yeni inceleme talebi")).toBe(true);
    expect(isRelevantNews("Bulls Portföy'den fon portföylerine ilişkin açıklama")).toBe(true);
    expect(findTickers("Tera Yatırım'dan açıklama")).toContain("TERA");
    expect(findTickers("Tera Portföy yeni fonunu duyurdu")).not.toContain("TERA");
  });

  it("does not match short finance terms inside unrelated words", () => {
    expect(isRelevantNews("Silivri'de 13 gün yerde yattım tahtakurusu yedi")).toBe(false);
    expect(isRelevantNews("Yapay zeka dünyanın sonunu mu getirecek?")).toBe(false);
    expect(isRelevantNews("Paralarını kurtarmak için iade kuyruğuna geçtiler")).toBe(false);
    expect(isRelevantNews("Süper Lig'in eski yıldızı silindirin altında kaldı")).toBe(false);
  });

  it("rejects broad economy stories outside the BIST and fund focus", () => {
    expect(isRelevantNews("Oyun içi satın almalara dikkat!", "Kayıtlı kredi kartıyla yapılan harcamalar aile bütçesini etkiliyor.")).toBe(false);
    expect(isRelevantNews("Turist gelsin diye ormana 1 milyon liralık altın sakladılar")).toBe(false);
    expect(isRelevantNews("Hong Kong borsasında güçlü kapanış: Hang Seng yüzde 1,18 yükseldi")).toBe(false);
    expect(isRelevantNews("Bessent'ten tahvil ve Fed mesajı: Faizler savaş sonrası düşebilir")).toBe(false);
    expect(isRelevantNews("Ulaştırmada demir yolu önceliği", "Kamu Yatırım Programı kapsamında yeni projeler hazırlanacak.")).toBe(false);
    expect(isRelevantNews("Trafigura, Volare Shipping için halka arz planlıyor", "Şirket Londra piyasasını değerlendiriyor.")).toBe(false);
    expect(isRelevantNews("ABD merkezli yatırım fonu teknoloji hisselerine yöneldi")).toBe(false);
  });

  it("keeps Turkish market-moving macro and listed-company stories", () => {
    expect(isRelevantNews("TCMB politika faizi kararını açıkladı")).toBe(true);
    expect(isRelevantNews("Türkiye'de yıllık enflasyon geriledi")).toBe(true);
    expect(isRelevantNews("Gen İlaç'tan açıklama", "Gen İlaç ve Sağlık Ürünleri A.Ş. (GENIL) yeni kararını duyurdu.")).toBe(true);
    expect(isRelevantNews("Adra GYO'dan 250 milyon TL'lik pay geri alım kararı")).toBe(true);
    expect(isRelevantNews("Türkiye'de yeni halka arz için hazırlık başladı")).toBe(true);
  });
});
