import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPredictionConsistency, normalizePrediction, type ConsistencyWarning } from "../src/consistency";
import type { HorseFormSnapshot } from "../src/form";
import { formatPastRun } from "../src/umabashira";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(fixtureDir, "fixtures/20261108-05-11-page.md"), "utf8");
const form = JSON.parse(readFileSync(join(fixtureDir, "fixtures/20261108-05-11-form.json"), "utf8")) as Array<{
  horseName: string;
  horseNumber: number | null;
  weightToCarryKg: number | null;
  pastRuns: Array<{ raceName: string; officialResult: number | null }>;
}>;

function horses(): HorseFormSnapshot[] {
  return form.map((horse) => ({
    horseName: horse.horseName,
    horseNumber: horse.horseNumber,
    resolvedName: horse.horseName,
    resolutionStatus: "unique",
    pastRunCount: horse.pastRuns.length,
    birthDate: null,
    careerStarts: null,
    prevOfficialResult: null,
    prevDistance: null,
    prevSurface: null,
    daysSinceLastRace: null,
    weightToCarryKg: horse.weightToCarryKg,
    pastRuns: horse.pastRuns.map((run) => ({
      raceName: run.raceName,
      date: null,
      officialResult: run.officialResult,
      surface: null,
      distance: null,
    })),
  }));
}

function warning(list: ConsistencyWarning[], horseName: string, raceName: string): ConsistencyWarning | undefined {
  return list.find((item) => item.horseName === horseName && item.raceName === raceName);
}

describe("20261108 prediction fixture", () => {
  const warnings = checkPredictionConsistency(page, horses());

  it("detects the wrong finishes and keeps the correct ones", () => {
    const kings = warning(warnings, "キングスコール", "目黒記念");
    expect(kings).toMatchObject({ claimed: "3着", actual: "5着" });
    expect(kings?.snippet).toMatch(/目黒記念.*3着/);
    const west = warning(warnings, "ウエストナウ", "京都大賞典");
    expect(west).toMatchObject({ claimed: "4着", actual: "6着" });
    expect(west?.snippet).toContain("京都大賞典4着");
    expect(warning(warnings, "ウエストナウ", "メトロポリタンステークス")).toBeUndefined();
    expect(warning(warnings, "ミクニインスパイア", "日経賞")).toBeUndefined();
    expect(warning(warnings, "ミラージュナイト", "目黒記念")).toBeUndefined();
    expect(warning(warnings, "ファイアンクランツ", "目黒記念")).toBeUndefined();
  });

  it("only warns on claims inside that horse's section", () => {
    const normalized = normalizePrediction(page);
    const names = horses().map((horse) => horse.horseName);
    expect(warnings.map((item) => `${item.horseName} ${item.raceName} ${item.claimed} 「${item.snippet}」`)).toEqual([
      "マイネルエンペラー 日経賞 2着 「日経賞2着」",
      "ファミリータイム 日経新春杯 1着 「日経新春杯勝ち」",
      "ウエストナウ 京都大賞典 4着 「京都大賞典4着」",
      "キングスコール 目黒記念 3着 「目黒記念3着」",
    ]);
    for (const item of warnings) {
      expect(normalized).toContain(item.snippet);
      expect(sectionHorse(normalized, item.snippet, names)).toBe(item.horseName);
      const claimedPlace = Number(item.claimed.replace("着", ""));
      const actualPlaces = item.actual.split("・").map((part) => Number(part.replace("着", "")));
      expect(actualPlaces).not.toContain(claimedPlace);
    }
  });
});

function sectionHorse(text: string, snippet: string, names: string[]): string | null {
  const at = text.indexOf(snippet);
  if (at < 0) return null;
  const ordered = [...names].sort((a, b) => b.length - a.length);
  const lines = text.slice(0, at).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim().replace(/^[-*]\s*/, "");
    if (/^#{1,6}\s/.test(line) || line === "---") return null;
    for (const name of ordered) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^(?:\\d+位\\s+)?(?:[◎◯○▲☆△★]\\s*)?(?:\\d{1,2}\\s+)?${escaped}(?=$|[\\s（(・はのがを])`).test(line)) {
        return name;
      }
    }
  }
  return null;
}

describe("claim shapes", () => {
  function horse(name: string, raceName: string, officialResult: number): HorseFormSnapshot {
    return {
      horseName: name,
      horseNumber: 1,
      resolvedName: name,
      resolutionStatus: "unique",
      pastRunCount: 1,
      birthDate: null,
      careerStarts: null,
      prevOfficialResult: null,
      prevDistance: null,
      prevSurface: null,
      daysSinceLastRace: null,
      weightToCarryKg: 57,
      pastRuns: [{ raceName, date: null, officialResult, surface: null, distance: null }],
    };
  }

  it("reads full-width digits, particles, and win words without borrowing the next race", () => {
    const kings = horse("キングスコール", "目黒記念", 5);
    const west = horse("ウエストナウ", "京都大賞典", 6);
    const metro = horse("ウエストナウ", "メトロポリタンステークス", 1);
    const emperor = horse("マイネルエンペラー", "日経賞", 1);
    expect(checkPredictionConsistency("キングスコールは目黒記念で３着。", [kings])[0]).toMatchObject({
      claimed: "3着",
      snippet: "目黒記念で3着",
    });
    expect(checkPredictionConsistency("ウエストナウの前走京都大賞典は4着。", [west])[0]?.snippet).toBe("京都大賞典は4着");
    expect(checkPredictionConsistency("ウエストナウは京都大賞典4着。", [west])[0]?.claimed).toBe("4着");
    expect(checkPredictionConsistency("ウエストナウはメトロポリタンSを勝利。", [metro])).toEqual([]);
    expect(checkPredictionConsistency("マイネルエンペラーは日経賞優勝。", [emperor])).toEqual([]);
    const fian = {
      ...horse("ファイアンクランツ", "目黒記念", 1),
      pastRuns: [
        { raceName: "目黒記念", date: null, officialResult: 1, surface: null, distance: null },
        { raceName: "ダイヤモンドステークス", date: null, officialResult: 2, surface: null, distance: null },
      ],
      pastRunCount: 2,
    };
    expect(checkPredictionConsistency("ファイアンクランツは目黒記念勝ち馬。ダイヤモンドS2着。", [fian])).toEqual([]);
    const mixed = checkPredictionConsistency(
      ["- ◯ 4 ミラージュナイト （目黒記念僅差）", "- ☆ 17 キングスコール （目黒記念3着）"].join("\n"),
      [horse("ミラージュナイト", "目黒記念", 4), kings],
    );
    expect(mixed.map((item) => item.horseName)).toEqual(["キングスコール"]);
  });
});

describe("finished run lines", () => {
  it("fails if a finished run omits the placing", () => {
    const rows = [
      {
        race_meeting_date: "2026-05-31T00:00:00Z",
        race_track: "東京",
        surface: "芝",
        distance: 2500,
        rail_type: "C",
        track_condition: "良",
        grade: "G2",
        race_condition: "オープン",
        race_name_main: "目黒記念",
        race_abnormality: "異常なし",
        official_result: 4,
        scheduled_horse_count: 14,
        entry_status: "finished",
        finish_time_sec: 150,
      },
      {
        race_name_main: "目黒記念",
        race_abnormality: "異常なし",
        official_result: 5,
        scheduled_horse_count: 14,
        entry_status: "finished",
      },
      {
        race_meeting_date: "2026-10-04T00:00:00Z",
        race_track: "京都",
        surface: "芝",
        distance: 2400,
        race_name_main: "京都大賞典",
        race_abnormality: "異常なし",
        official_result: 6,
        scheduled_horse_count: 18,
        entry_status: "finished",
      },
    ];
    const lines = rows.map((row) => formatPastRun(row));
    expect(lines.every((line) => /\d+着/.test(line))).toBe(true);
    expect(lines[0]).toContain("4着/14頭");
    expect(lines[1]).toContain("5着/14頭");
    expect(lines[2]).toContain("京都大賞典");
    expect(lines[2]).toContain("6着/18頭");
    expect(lines.join("\n")).not.toContain("異常なし");
  });
});
