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
});
