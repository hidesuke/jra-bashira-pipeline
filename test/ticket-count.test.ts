import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { correctTicketCounts } from "../src/ticket-count";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(fixtureDir, "fixtures/20261108-05-11-page.md"), "utf8");

describe("correctTicketCounts", () => {
  it("recounts the fixture 3連複 formation from 9 to 12 and leaves the rest of the page", () => {
    const corrected = correctTicketCounts(page);
    expect(corrected.corrections).toEqual([{ tickets: "3連複", declared: 9, counted: 12 }]);
    expect(corrected.text).toBe(page.replace("3連複フォーメーション（9点）", "3連複フォーメーション（12点）"));
    expect(corrected.text).toContain("馬連・馬単フォーメーション（4点）");
    expect(corrected.text).toContain("ワイド（2点）");
    expect(corrected.text).toContain("3連複抑え（3点）");
  });

  it("drops the same horse and duplicate sets inside a formation", () => {
    const text = [
      "- 3連複フォーメーション（4点）:",
      "- 1頭目: 7",
      "- 2頭目: 4, 5, 17",
      "- 3頭目: 4, 5, 17",
    ].join("\n");
    // {4,5,7} {4,7,17} {5,7,17} の3組。同じ馬の組と、列を入れ替えただけの組は数えない。
    expect(correctTicketCounts(text)).toEqual({
      text: text.replace("（4点）", "（3点）"),
      corrections: [{ tickets: "3連複", declared: 4, counted: 3 }],
    });
  });

  it("counts ordered 3連単 selections and skips a repeated horse", () => {
    const text = ["3連単フォーメーション（4点）", "1頭目: 7", "2頭目: 4, 7", "3頭目: 5"].join("\n");
    expect(correctTicketCounts(text).text).toBe(text.replace("（4点）", "（1点）"));
    expect(correctTicketCounts(text).corrections).toEqual([{ tickets: "3連単", declared: 4, counted: 1 }]);
  });

  it("adds 馬連 and 馬単 on the same formation", () => {
    const text = ["馬連・馬単フォーメーション（4点）", "1頭目: 7", "2頭目: 4, 5", "7 → 4, 5（馬単・馬連）"].join("\n");
    const corrected = correctTicketCounts(text);
    expect(corrected.corrections).toEqual([]);
    expect(corrected.text).toBe(text);
  });

  it("counts a box from the unique horses", () => {
    const trio = ["3連複ボックス（10点）", "7, 4, 5, 9, 7"].join("\n");
    expect(correctTicketCounts(trio).corrections).toEqual([{ tickets: "3連複", declared: 10, counted: 4 }]);
    const exacta = ["馬単ボックス（3点）", "1, 2, 3"].join("\n");
    expect(correctTicketCounts(exacta).corrections).toEqual([{ tickets: "馬単", declared: 3, counted: 6 }]);
    const quinella = ["馬連ボックス（6点）", "1, 2, 3, 4"].join("\n");
    expect(correctTicketCounts(quinella).corrections).toEqual([]);
  });

  it("counts nagashi without the axis horse in the opponents", () => {
    const trio = ["3連複軸1頭流し（99点）", "軸: 7", "相手: 7, 4, 5, 9"].join("\n");
    expect(correctTicketCounts(trio).corrections).toEqual([{ tickets: "3連複", declared: 99, counted: 3 }]);
    const trifecta = ["3連単1着ながし（99点）", "軸: 7", "相手: 4, 5, 9"].join("\n");
    expect(correctTicketCounts(trifecta).corrections).toEqual([{ tickets: "3連単", declared: 99, counted: 6 }]);
    const exacta = ["馬単マルチ（3点）", "軸: 7", "相手: 4, 5, 9"].join("\n");
    expect(correctTicketCounts(exacta).corrections).toEqual([{ tickets: "馬単", declared: 3, counted: 6 }]);
    const oneWay = ["馬単流し（3点）", "7 → 4, 5, 9"].join("\n");
    expect(correctTicketCounts(oneWay).corrections).toEqual([]);
  });

  it("counts listed wide pairs and a dash formation", () => {
    const wide = ["ワイド（4点）", "7 - 17", "4 - 17"].join("\n");
    expect(correctTicketCounts(wide).corrections).toEqual([{ tickets: "ワイド", declared: 4, counted: 2 }]);
    const saver = ["3連複抑え（9点）", "4 - 5 - 7, 9, 17"].join("\n");
    expect(correctTicketCounts(saver).corrections).toEqual([{ tickets: "3連複", declared: 9, counted: 3 }]);
  });

  it("replaces only the digits and leaves an unreadable bet unchanged", () => {
    const text = [
      "- <b>3連複フォーメーション（９点）:</b>",
      "- 1頭目: 7",
      "- 2頭目: 4, 5",
      "- 3頭目: 3, 9",
      "- 3連複（9点）: 本命から厚く",
      "- 指数は86点",
    ].join("\n");
    const corrected = correctTicketCounts(text);
    expect(corrected.text).toBe(text.replace("（９点）", "（4点）"));
    expect(corrected.corrections).toEqual([{ tickets: "3連複", declared: 9, counted: 4 }]);
    expect(corrected.text).toContain("3連複（9点）");
    expect(corrected.text).toContain("86点");
    expect(corrected.text).toContain("<b>");
  });

  it("keeps going when one heading cannot be parsed", () => {
    const text = ["3連複（9点）", "文章だけで馬番の列が無い", "ワイド（9点）", "7 - 17"].join("\n");
    const corrected = correctTicketCounts(text);
    expect(corrected.text.startsWith("3連複（9点）")).toBe(true);
    expect(corrected.text).toContain("ワイド（1点）");
    expect(corrected.corrections).toEqual([{ tickets: "ワイド", declared: 9, counted: 1 }]);
  });

  it("returns the original text when there is nothing to count", () => {
    const text = "a\n\nb\n";
    expect(correctTicketCounts(text)).toEqual({ text, corrections: [] });
    expect(correctTicketCounts("<<<")).toEqual({ text: "<<<", corrections: [] });
    const fenced = ["```", "3連複フォーメーション（9点）", "1頭目: 1", "2頭目: 2", "3頭目: 3", "```"].join("\n");
    expect(correctTicketCounts(fenced).corrections).toEqual([]);
  });
});
