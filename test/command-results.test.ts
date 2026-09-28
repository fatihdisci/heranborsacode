import { describe, expect, it } from "vitest";
import { commandMediaUrl, finalCommandResults, isProgressResponse, type CommandResultRow } from "../src/commands/results";

const row = (overrides: Partial<CommandResultRow>): CommandResultRow => ({
  step_index: 0, bot_username: "b0pt_bot", command: "/doviz", response_text: "", response_kind: "text",
  media_key: null, file_name: null, created_at: "2026-09-21 11:25:38", ...overrides,
});

describe("command result cleanup", () => {
  it("recognizes Turkish progress messages", () => {
    expect(isProgressResponse("🔄 Döviz kurları verisi alınıyor...")).toBe(true);
    expect(isProgressResponse("Sonuç hazır")).toBe(false);
  });

  it("removes progress rows when the same step has a final response", () => {
    const rows = [row({ response_text: "Veri alınıyor..." }), row({ response_text: "Sonuç", media_key: "commands/a/x.jpg", response_kind: "image" })];
    expect(finalCommandResults(rows).map(item => item.response_text)).toEqual(["Sonuç"]);
  });

  it("keeps a progress row when it is the only diagnostic response", () => {
    expect(finalCommandResults([row({ response_text: "Veri alınıyor..." })])).toHaveLength(1);
  });

  it("builds an encoded media URL", () => {
    expect(commandMediaUrl("commands/id/a b.jpg")).toBe("/api/commands/media/commands/id/a%20b.jpg");
  });
});
