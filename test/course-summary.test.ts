import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import {
  COURSE_RACE_COUNT_LIMIT,
  COURSE_SUMMARY_UNAVAILABLE,
  DEFAULT_COURSE_SUMMARY_MIN_COUNT,
  buildCourseSummaryPlan,
  collectCourseSummary,
  courseSummaryPeriod,
  courseSummaryText,
  failedCourseSummary,
  formatRate,
  renderCourseSummary,
} from "../src/course-summary";
import { catalogFromTools } from "../src/schema";
import { STATS_BATCH_SIZE } from "../src/types";
import { bashiraTools, tool } from "./fixture";

const catalog = catalogFromTools(bashiraTools);

const kyotoPayloads = {
  totals: { columns: ["starts", "wins", "top3"], rows: [[5598, 436, 1306]], data_through: "2026-11-03" },
  "corner:lead": { columns: ["starts", "wins", "top3"], rows: [[435, 134, 273]] },
  "corner:2-4": { columns: ["starts", "wins", "top3"], rows: [[1578, 212, 632]] },
  "corner:5-9": { columns: ["starts", "wins", "top3"], rows: [[2046, 80, 343]] },
  "corner:10plus": { columns: ["starts", "wins", "top3"], rows: [[1539, 10, 58]] },
  fastest: { columns: ["starts", "wins"], rows: [[487, 211]] },
  bracket: {
    columns: ["bracket_number", "starts", "wins", "top3"],
    rows: [
      [1, 551, 39, 118],
      [2, 592, 42, 138],
      [3, 636, 35, 139],
      [4, 672, 44, 153],
      [5, 730, 62, 178],
      [6, 772, 79, 190],
      [7, 814, 56, 196],
      [8, 831, 79, 194],
    ],
  },
  going: {
    columns: ["track_condition", "wins", "front_wins"],
    rows: [
      ["重", 48, 37],
      ["良", 305, 241],
      ["稍重", 63, 52],
      ["不良", 20, 16],
    ],
  },
};

function finishedRaces(count: number, truncated = false): unknown {
  return {
    columns: ["race_id", "race_status"],
    rows: Array.from({ length: count }, (_, index) => [`race-${index}`, "finished"]),
    row_count: count,
    truncated,
  };
}

describe("course summary period", () => {
  it("ends the day before the race and goes back five years", () => {
    expect(courseSummaryPeriod("2026-11-08", 5)).toEqual({ from: "2021-11-07", to: "2026-11-07" });
    expect(courseSummaryPeriod("2024-03-01", 5)).toEqual({ from: "2019-02-28", to: "2024-02-29" });
    expect(DEFAULT_COURSE_SUMMARY_MIN_COUNT).toBe(30);
  });
});

describe("course summary queries", () => {
  const plan = buildCourseSummaryPlan({
    catalog,
    venue: "京都",
    surface: "ダート",
    distance: 1800,
    raceDate: "2026-11-08",
    periodYears: 5,
  });

  it("asks get_stats for counts only, on the same course and exact distance", () => {
    expect(plan.stats).toHaveLength(8);
    expect(plan.stats.length).toBeLessThanOrEqual(STATS_BATCH_SIZE);
    expect(plan.period).toEqual({ from: "2021-11-07", to: "2026-11-07" });
    const blob = JSON.stringify(plan);
    for (const banned of ["win_payout", "place_payout", "rail_type", "sire_name", "broodmare_sire_name", "jockey_name", "win_odds_rank", "min_starts", "race_year"]) {
      expect(blob).not.toContain(banned);
    }
    for (const stat of plan.stats) {
      expect(stat.args.filters).toMatchObject({
        race_track: "京都",
        surface: "ダート",
        distance: 1800,
        race_meeting_date: { gte: "2021-11-07", lte: "2026-11-07" },
      });
    }
    expect(plan.stats.map((stat) => stat.id)).toEqual([
      "totals",
      "corner:lead",
      "corner:2-4",
      "corner:5-9",
      "corner:10plus",
      "fastest",
      "bracket",
      "going",
    ]);
    expect(plan.races).toMatchObject({
      limit: COURSE_RACE_COUNT_LIMIT,
      filters: { race_status: "finished", distance: 1800 },
    });
  });

  it("does not call when the live schema lacks a field", () => {
    const narrow = catalogFromTools([tool("get_stats", ["filters"], ["race_track"]), tool("get_races", ["filters"], ["race_track"], ["filters"])]);
    expect(() =>
      buildCourseSummaryPlan({
        catalog: narrow,
        venue: "京都",
        surface: "ダート",
        distance: 1800,
        raceDate: "2026-11-08",
        periodYears: 5,
      }),
    ).toThrow(/推測では呼びません/);
  });
});

describe("course summary text", () => {
  it("renders Kyoto dirt 1800 from get_stats counts and computes the rates", () => {
    const rendered = renderCourseSummary({
      venue: "京都",
      surface: "ダート",
      distance: 1800,
      period: { from: "2021-11-07", to: "2026-11-07" },
      periodYears: 5,
      payloads: kyotoPayloads,
      racesPayload: finishedRaces(435),
      minCount: 30,
    });
    expect(rendered.raceCount).toBe(435);
    expect(rendered.raceCountTruncated).toBe(false);
    expect(rendered.text).toBe(
      [
        "コースデータ要約",
        "条件: 京都 ダート 1800m",
        "期間: 2021-11-07〜2026-11-07（レース日の前日までの過去5年）",
        "レース数: 435",
        "出走数: 5598　勝ち数: 436",
        "確定済みデータは 2026-11-03 まで。",
        "率は件数から計算した。回収率は含まない。4角の位置・上がり3F・枠番は JRA の走だけを数える。",
        "",
        "脚質（4角の位置）",
        "勝ち馬 436頭に占める割合",
        "- 先頭: 134頭（30.7%）",
        "- 2〜4番手: 212頭（48.6%）",
        "- 5〜9番手: 80頭（18.3%）",
        "- 10番手以下: 10頭（2.3%） 開催が少ないため参考値",
        "3着以内 1306頭に占める割合",
        "- 先頭: 273頭（20.9%）",
        "- 2〜4番手: 632頭（48.4%）",
        "- 5〜9番手: 343頭（26.3%）",
        "- 10番手以下: 58頭（4.4%）",
        "上がり3F最速: 出走 487　勝ち 211　勝率 43.3%",
        "",
        "内外",
        "- 1〜4枠: 出走 2451　勝ち 160　勝率 6.5%　複勝 548　複勝率 22.4%",
        "- 5〜8枠: 出走 3147　勝ち 276　勝率 8.8%　複勝 758　複勝率 24.1%",
        "",
        "馬場状態別の前残り（勝ち馬のうち4角4番手以内）",
        "- 良・稍重: 4番手以内 293頭 / 勝ち 368頭（79.6%）",
        "- 重・不良: 4番手以内 53頭 / 勝ち 68頭（77.9%）",
      ].join("\n"),
    );
    expect(formatRate(1, 0)).toBe("—");
  });

  it("keeps the numbers and marks a short meeting, and the same note on a small group", () => {
    const rendered = renderCourseSummary({
      venue: "京都",
      surface: "ダート",
      distance: 1800,
      period: { from: "2021-11-07", to: "2026-11-07" },
      periodYears: 5,
      payloads: kyotoPayloads,
      racesPayload: finishedRaces(12),
      minCount: 30,
    });
    expect(rendered.text).toContain("レース数: 12 開催が少ないため参考値");
    expect(rendered.text).toContain("勝ち数: 436");
    expect(rendered.text).toContain("- 10番手以下: 10頭（2.3%） 開催が少ないため参考値");
    const loose = renderCourseSummary({
      venue: "京都",
      surface: "ダート",
      distance: 1800,
      period: { from: "2021-11-07", to: "2026-11-07" },
      periodYears: 5,
      payloads: kyotoPayloads,
      racesPayload: finishedRaces(12),
      minCount: 10,
    });
    expect(loose.text).toContain("レース数: 12\n");
    expect(loose.text).not.toContain("10頭（2.3%） 開催が少ないため参考値");
    expect(loose.text.endsWith("- 重・不良: 4番手以内 53頭 / 勝ち 68頭（77.9%）")).toBe(true);
  });

  it("does not call a truncated race list a small sample", () => {
    const rendered = renderCourseSummary({
      venue: "京都",
      surface: "ダート",
      distance: 1800,
      period: { from: "2021-11-07", to: "2026-11-07" },
      periodYears: 5,
      payloads: kyotoPayloads,
      racesPayload: finishedRaces(10, true),
      minCount: 30,
    });
    expect(rendered.raceCountTruncated).toBe(true);
    expect(rendered.text).toContain("レース数: 10以上（一覧の上限で打ち切り）");
    expect(rendered.text.split("\n")[3]).not.toContain("参考値");
  });
});

describe("collectCourseSummary", () => {
  it("uses one get_stats batch and then get_races", async () => {
    const calls: string[] = [];
    const bashira: BashiraPort = {
      async listTools() {
        return { ok: true, tools: [] };
      },
      async callTool(name) {
        calls.push(name);
        return { ok: true, data: finishedRaces(435) };
      },
      async callTools(batch) {
        calls.push(`stats:${batch.length}`);
        return {
          ok: true,
          results: batch.map((call) => payloadFor(call.args)),
        };
      },
    };
    const record = await collectCourseSummary({
      bashira,
      catalog,
      venue: "京都",
      surface: "ダート",
      distance: 1800,
      raceDate: "2026-11-08",
      periodYears: 5,
      minCount: 30,
    });
    expect(calls).toEqual(["stats:8", "get_races"]);
    expect(record.status).toBe("ok");
    expect(record.text).toContain("京都 ダート 1800m");
    expect(record.raceCount).toBe(435);
  });

  it("stops the summary when get_stats fails and does not ask for races", async () => {
    let races = 0;
    const bashira: BashiraPort = {
      async listTools() {
        return { ok: true, tools: [] };
      },
      async callTool() {
        races += 1;
        return { ok: true, data: {} };
      },
      async callTools() {
        return { ok: false, code: "upstream", retryable: true, message: "stats down", results: [] };
      },
    };
    await expect(
      collectCourseSummary({
        bashira,
        catalog,
        venue: "京都",
        surface: "ダート",
        distance: 1800,
        raceDate: "2026-11-08",
        periodYears: 5,
        minCount: 30,
      }),
    ).rejects.toThrow(/stats down/);
    expect(races).toBe(0);
    expect(courseSummaryText(failedCourseSummary("stats down"))).toBe(COURSE_SUMMARY_UNAVAILABLE);
    expect(courseSummaryText(null)).toBe(COURSE_SUMMARY_UNAVAILABLE);
  });
});

function payloadFor(args: Record<string, unknown>): unknown {
  const filters = (args.filters ?? {}) as Record<string, unknown>;
  const dimensions = args.dimensions as string[] | undefined;
  if (dimensions?.[0] === "bracket_number") return kyotoPayloads.bracket;
  if (dimensions?.[0] === "track_condition") return kyotoPayloads.going;
  if (filters.is_fastest_last_3f === true) return kyotoPayloads.fastest;
  const corner = filters.fourth_corner_position;
  if (corner === 1) return kyotoPayloads["corner:lead"];
  if (corner && typeof corner === "object" && (corner as { gte?: number }).gte === 2) return kyotoPayloads["corner:2-4"];
  if (corner && typeof corner === "object" && (corner as { gte?: number }).gte === 5) return kyotoPayloads["corner:5-9"];
  if (corner && typeof corner === "object" && (corner as { gte?: number }).gte === 10) return kyotoPayloads["corner:10plus"];
  return kyotoPayloads.totals;
}
