import { describe, expect, it } from "vitest";
import { isRelevantNews, isTurkishNews } from "../src/rss/filter";

describe("RSS news filters", () => {
  it("keeps Turkish market news", () => {
    expect(isTurkishNews("Borsa İstanbul'da bankacılık hisseleri yükseldi")).toBe(true);
    expect(isRelevantNews("Borsa İstanbul'da bankacılık hisseleri yükseldi")).toBe(true);
  });

  it("rejects English and off-topic headlines", () => {
    expect(isTurkishNews("Russia, Ukraine trade major drone attacks as Moscow oil refinery hit")).toBe(false);
    expect(isRelevantNews("Türkiye'nin tek üç Michelin anahtarlı oteli oldu")).toBe(false);
  });
});
