import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import { pageBlocks, pageMarkdown } from "../src/body";
import { fillRaceUser, RACE_USER_PLACEHOLDERS } from "../src/dify-input";
import {
  careerQuery,
  countPlaces,
  formatPlaceCounts,
  loadPastPerformance,
  planCareerBatches,
  planPaceQueries,
  raceIdOf,
  renderCourseRecords,
  renderPastRuns,
  type CareerHorse,
} from "../src/past-runs";
import { relatedCoursesGap, stripRelatedCourses } from "../src/related-courses";
import { renderWinOddsText, type OddsSummary } from "../src/odds";
import type { RaceRef } from "../src/types";
import { catalogFromTools } from "../src/schema";
import { bashiraTools } from "./fixture";

const race: RaceRef = {
  raceKey: "20261108-05-11",
  raceId: "20261108-05-11",
  date: "2026-11-08",
  venue: "東京",
  venueCode: "05",
  raceNumber: 11,
};

const horse: CareerHorse = {
  horseName: "ア",
  queryName: "ア",
  horseNumber: 1,
  careerStarts: 8,
  unresolved: false,
};

describe("related-courses block", () => {
  const analysis = "東京芝2400はスタミナが問われる。";
  const block = ["<<<related-courses>>>", "東京,芝,2400", "中京, 芝, 2200", "<<<end>>>"].join("\n");

  it("reads a closed block and drops the surrounding blank lines", () => {
    const raw = `${analysis}\n\n${block}\n\n`;
    const stripped = stripRelatedCourses(raw);
    expect(stripped.parse.status).toBe("ok");
    expect(stripped.parse.courses).toEqual([
      { track: "東京", surface: "芝", distance: 2400 },
      { track: "中京", surface: "芝", distance: 2200 },
    ]);
    expect(stripped.text).toBe(analysis);
    expect(relatedCoursesGap(stripped.parse)).toBeNull();
    const between = stripRelatedCourses(`${analysis}\n\n${block}\n\nまだ本文`);
    expect(between.text).toBe(`${analysis}\n\nまだ本文`);
  });

  it("keeps the text when the block is absent", () => {
    const stripped = stripRelatedCourses(analysis);
    expect(stripped.parse.status).toBe("absent");
    expect(stripped.parse.courses).toEqual([]);
    expect(stripped.text).toBe(analysis);
    expect(relatedCoursesGap(stripped.parse)).toBe("関連コース（コース分析に一覧が無い）");
  });

  it("does not eat the analysis when the close tag is missing", () => {
    const raw = `${analysis}\n\n<<<related-courses>>>\n東京,芝,2400\n\nまだ本文`;
    const stripped = stripRelatedCourses(raw);
    expect(stripped.parse.status).toBe("unclosed");
    expect(stripped.text).toBe(raw);
    expect(stripped.text).toContain("まだ本文");
    expect(relatedCoursesGap(stripped.parse)).toBe("関連コース（<<<end>>> が無い）");
  });

  it("strips a closed block whose lines cannot be read and does not count them", () => {
    const raw = `${analysis}\n\n<<<related-courses>>>\n東京芝2400\n<<<end>>>`;
    const stripped = stripRelatedCourses(raw);
    expect(stripped.parse.status).toBe("malformed");
    expect(stripped.parse.courses).toEqual([]);
    expect(stripped.text).toBe(analysis);
    expect(relatedCoursesGap(stripped.parse)).toBe("関連コース（一覧の行を読めない）");
  });

  it("keeps the first five courses and records the rest as dropped", () => {
    const lines = ["東京,芝,2400", "中京,芝,2200", "中京,芝,2000", "東京,芝,3400", "新潟,芝,2400", "阪神,芝,2400", "東京,芝,2400"];
    const raw = ["<<<related-courses>>>", ...lines, "<<<end>>>"].join("\n");
    const stripped = stripRelatedCourses(raw);
    expect(stripped.parse.status).toBe("ok");
    expect(stripped.parse.courses).toHaveLength(5);
    expect(stripped.parse.courses.map((course) => course.track)).toEqual(["東京", "中京", "中京", "東京", "新潟"]);
    expect(stripped.parse.dropped).toBe(1);
    expect(relatedCoursesGap(stripped.parse)).toBe("関連コース（6件目以降は数えない）");
  });
});

describe("course records", () => {
  const rows = [
    run({ date: "2026-11-08", track: "東京", number: 11, surface: "芝", distance: 2400, place: null, status: "upcoming" }),
    run({ date: "2026-10-01", track: "東京", number: 11, surface: "芝", distance: 2400, place: 1 }),
    run({ date: "2026-09-01", track: "東京", number: 10, surface: "芝", distance: 2400, place: 2 }),
    run({ date: "2026-08-01", track: "東京", number: 9, surface: "芝", distance: 1800, place: 6 }),
    run({ date: "2026-07-01", track: "東京", number: 8, surface: "ダート", distance: 1600, place: 1 }),
    run({ date: "2026-06-01", track: "中京", number: 11, surface: "芝", distance: 2200, place: 3 }),
    run({ date: "2026-05-01", track: "中京", number: 10, surface: "芝", distance: 2200, place: null, abnormality: "競走中止" }),
    run({ date: "2026-04-01", track: "阪神", number: 11, surface: "芝", distance: 2000, place: 4 }),
  ];

  it("counts same course, same track, and the sum of related courses", () => {
    const current = { track: "東京", surface: "芝", distance: 2400 };
    const related = [
      { track: "東京", surface: "芝", distance: 2400 },
      { track: "中京", surface: "芝", distance: 2200 },
    ];
    const text = renderCourseRecords({ race, horses: [horse], rows, current, related });
    expect(text).toContain("同じコース: (1,1,0,0,0,0)");
    expect(text).toContain("同じ競馬場: (1,1,0,0,0,1)");
    expect(text).toContain("関連コース: (1,1,1,0,0,0)");
    expect(text).toContain("関連コース: 東京,芝,2400 / 中京,芝,2200");
    expect(countPlaces(rows, race, () => true)).toEqual({ first: 2, second: 1, third: 1, fourth: 1, fifth: 0, other: 1 });
    expect(formatPlaceCounts({ first: 1, second: 0, third: 2, fourth: 3, fifth: 4, other: 4 })).toBe("(1,0,2,3,4,4)");
  });

  it("leaves related records blank when the list cannot be read", () => {
    const text = renderCourseRecords({
      race,
      horses: [horse],
      rows,
      current: { track: "東京", surface: "芝", distance: 2400 },
      related: null,
    });
    expect(text).toContain("関連コース: 一覧が読めないため空欄");
    expect(text).toContain("同じコース: (1,1,0,0,0,0)");
    expect(text).toMatch(/関連コース: $/m);
    expect(text).not.toContain("関連コース: (");
  });

  it("does not count an unresolved horse", () => {
    const text = renderCourseRecords({
      race,
      horses: [{ ...horse, unresolved: true }],
      rows,
      current: { track: "東京", surface: "芝", distance: 2400 },
      related: [],
    });
    expect(text).toContain("同名馬のため成績を数えない");
    expect(text).toContain("同じコース: \n同じ競馬場: \n関連コース: ");
    expect(text).not.toContain("(0,0,0,0,0,0)");
  });
});

describe("past runs table", () => {
  it("includes popularity, win odds, and the race's first and last 3F", () => {
    const row = run({
      date: "2026-10-12",
      track: "東京",
      number: 5,
      surface: "芝",
      distance: 1600,
      place: 2,
    });
    row.grade = "G3";
    row.race_condition = "3勝クラス";
    row.race_name_main = "前走";
    row.rail_type = "A";
    row.track_condition = "良";
    row.scheduled_horse_count = 16;
    row.finish_time_sec = 93.2;
    row.time_difference_with_winner_sec = 0.2;
    row.last_3f_sec = 33.8;
    row.last_3f_rank = 1;
    row.first_corner_position = 3;
    row.second_corner_position = 3;
    row.third_corner_position = 2;
    row.fourth_corner_position = 2;
    row.jockey_name = "騎手A";
    row.is_jockey_change = false;
    row.weight_to_carry_kg = 56;
    row.horse_weight = 470;
    row.horse_weight_difference_with_previous_race = -2;
    row.horse_number = 3;
    row.days_since_last_race = 28;
    row.win_odds_rank = 4;
    row.win_odds = 6.5;
    const text = renderPastRuns({
      race,
      horses: [horse],
      rows: [row],
      paces: new Map([["20261012-05-05", { first3f: 34.5, last3f: 35.6 }]]),
    });
    expect(text).toContain("| 人気 | 単勝 | 前半3F | 後半3F |");
    expect(text).toContain("| 2026-10-12 | 東京 | 前走 | G3 | 3勝クラス | 芝 | 1600 | A | 良 | 16 | 2 | 1:33.2 | 0.2 | 33.8 | 1 | 3-3-2-2 | 騎手A | なし | 56 | 470 | -2 | 3 | 28 | 4 | 6.5 | 34.5 | 35.6 |");
    expect(raceIdOf(row)).toBe("20261012-05-05");
    expect(raceIdOf({ race_meeting_date: "2026-10-12", race_track: "地方", race_number: 1 })).toBeNull();
  });

  it("plans one get_entries until the row budget, then another, and chunks pace ids by 100", () => {
    const light = Array.from({ length: 10 }, (_, index) => horseOf(index, 10));
    expect(planCareerBatches(light)).toHaveLength(1);
    const heavy = [horseOf(1, 200), horseOf(2, 200), horseOf(3, 200)];
    const batches = planCareerBatches(heavy);
    expect(batches.map((batch) => batch.map((item) => item.horseNumber))).toEqual([[1, 2], [3]]);
    const names = Array.from({ length: 101 }, (_, index) => horseOf(index + 1, 0));
    expect(planCareerBatches(names).map((batch) => batch.length)).toEqual([100, 1]);
    expect(careerQuery(race, [horse], ["horse_name"]).filters).toMatchObject({ horse_name: "ア" });
    expect(careerQuery(race, [horse, horseOf(2, 1)], ["horse_name"]).filters).toMatchObject({ horse_name: ["ア", "馬2"] });
    const queries = planPaceQueries(Array.from({ length: 101 }, (_, index) => `id-${index}`));
    expect(queries).toHaveLength(2);
    expect((queries[0]?.filters as { race_id: string[] }).race_id).toHaveLength(100);
    expect((queries[1]?.filters as { race_id: string }).race_id).toBe("id-100");
  });

  it("splits a truncated get_entries and still returns both horses", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bashira: BashiraPort = {
      async listTools() {
        return { ok: true, tools: [] };
      },
      async callTool(name, args) {
        calls.push({ name, ...args });
        if (name === "get_races") {
          return { ok: true, data: { rows: [{ race_id: "20261012-05-05", first_3f_sec: 34.5, last_3f_sec: 35.6 }] } };
        }
        const names = (args.filters as { horse_name: string | string[] }).horse_name;
        if (Array.isArray(names)) return { ok: true, data: { truncated: true, rows: [] } };
        return {
          ok: true,
          data: {
            truncated: false,
            rows: [run({ date: "2026-10-12", track: "東京", number: 5, surface: "芝", distance: 1600, place: 1, name: String(names) })],
          },
        };
      },
      async callTools() {
        return { ok: true, results: [] };
      },
    };
    const horses = [horse, horseOf(2, 200)];
    const loaded = await loadPastPerformance({
      bashira,
      catalog: catalogFromTools(bashiraTools),
      race,
      horses,
    });
    expect(loaded.careerCalls).toBe(3);
    expect(loaded.rows.map((row) => row.horse_name).sort()).toEqual(["ア", "馬2"]);
    expect(loaded.paceCalls).toBe(1);
    expect(loaded.paces.get("20261012-05-05")).toEqual({ first3f: 34.5, last3f: 35.6 });
    expect(calls.filter((call) => call.name === "get_entries")).toHaveLength(3);
  });
});

describe("race prompt variables and notion order", () => {
  const values = {
    race_facts: "# レース情報\nレース名: テスト",
    umabashira: "# 馬柱",
    course_analysis: "コース本文",
    weather: "晴",
    condition: "良",
    remarks: "なし",
    past_runs: "# 過去走（近10走）\n表",
    course_records: "# コース成績\n同じコース: (1,0,0,0,0,0)",
    runner_stats: "# 出走馬のコース成績\n父 父一: 出走 48　勝ち 8　勝率 16.7%　複勝 20　複勝率 41.7%",
    win_odds: "# 単勝オッズ\n観測時刻: 2026-11-07T15:04:00+09:00\n種別: 最終\n1 ア: 3.1\n2 イ: ",
  };

  it("renders a v1.6.0-shaped template and prepends only the blocks that are not placed", () => {
    const legacy = [
      RACE_USER_PLACEHOLDERS.umabashira,
      RACE_USER_PLACEHOLDERS.course_analysis,
      RACE_USER_PLACEHOLDERS.weather,
      RACE_USER_PLACEHOLDERS.condition,
      RACE_USER_PLACEHOLDERS.remarks,
    ].join("\n");
    const filled = fillRaceUser(legacy, values);
    expect(filled.startsWith("# レース情報")).toBe(true);
    expect(filled.indexOf("# 過去走（近10走）")).toBeLessThan(filled.indexOf("# 馬柱"));
    expect(filled.indexOf("# コース成績")).toBeLessThan(filled.indexOf("# 出走馬のコース成績"));
    expect(filled.indexOf("# 出走馬のコース成績")).toBeLessThan(filled.indexOf("# 馬柱"));
    expect(filled).not.toContain("# 単勝オッズ");
    expect(filled).not.toContain("{{");
    const placed = fillRaceUser(
      `${RACE_USER_PLACEHOLDERS.past_runs}\n${RACE_USER_PLACEHOLDERS.course_records}\n${RACE_USER_PLACEHOLDERS.runner_stats}\n${RACE_USER_PLACEHOLDERS.win_odds}\n${RACE_USER_PLACEHOLDERS.race_facts}`,
      values,
    );
    expect(placed.indexOf("# 過去走（近10走）")).toBe(placed.lastIndexOf("# 過去走（近10走）"));
    expect(placed.indexOf("# コース成績")).toBe(placed.lastIndexOf("# コース成績"));
    expect(placed.indexOf("# 出走馬のコース成績")).toBe(placed.lastIndexOf("# 出走馬のコース成績"));
    expect(placed).toContain("1 ア: 3.1");
    expect(placed).toContain("2 イ: ");
    expect(placed.startsWith("# 過去走（近10走）")).toBe(true);
  });

  it("places course analysis before the ranking and drops the win-odds section", () => {
    const odds: OddsSummary = {
      source: "get_odds",
      available: true,
      kind: "最終",
      observedAtJst: "2026-11-07T15:04:00+09:00",
      reason: null,
      detail: null,
      horses: [{ horseNumber: 1, selection: "1", odds: 3.1, oddsMin: null, oddsMax: null, status: null, kind: "最終", observedAtJst: "2026-11-07T15:04:00+09:00" }],
    };
    const input = {
      race,
      raceName: "テストS",
      requestedBy: "Grok Bot",
      odds,
      courseModel: "gemini-flash-latest",
      raceModel: "gemini-flash-latest",
      courseModelVersion: null,
      raceModelVersion: null,
      coursePromptVersion: "1",
      racePromptVersion: "1",
      印: "",
      予想本文: ["### レース総合判定", "判定", "", "### 指数ランキングと短評", "短評", "", "### 買い目推奨・馬券戦術", "買い"].join("\n"),
      courseText: "分析本文\n\n<<<related-courses>>>\n東京,芝,2400\n<<<end>>>\n",
    };
    const markdown = pageMarkdown(input);
    expect(markdown).not.toContain("<<<related-courses>>>");
    expect(markdown).not.toContain("<<<end>>>");
    expect(markdown).not.toContain("単勝オッズ");
    expect(markdown.indexOf("### コース分析")).toBeLessThan(markdown.indexOf("### 指数ランキングと短評"));
    expect(markdown.indexOf("### レース総合判定")).toBeLessThan(markdown.indexOf("### 買い目推奨・馬券戦術"));
    expect(markdown).toContain("分析本文");
    const blocks = JSON.stringify(pageBlocks(input));
    expect(blocks).not.toContain("### 単勝オッズ");
    expect(blocks).toContain("オッズ種別: 最終");
    const unclosed = pageMarkdown({ ...input, 予想本文: "本文", courseText: "分析\n<<<related-courses>>>\n東京,芝,2400" });
    expect(unclosed).toContain("<<<related-courses>>>");
    expect(unclosed).toContain("分析");
    const absent = pageMarkdown({ ...input, 予想本文: "短評だけ", courseText: "分析だけ" });
    expect(absent).toContain("### コース分析\n分析だけ");
    expect(absent.indexOf("短評だけ")).toBeLessThan(absent.indexOf("### コース分析"));
  });

  it("renders current win odds with the fetch time and blanks a horse without a price", () => {
    const text = renderWinOddsText(
      [
        { horse_number: 2, horse_name: "イ" },
        { horse_number: 1, horse_name: "ア" },
      ],
      {
        source: "get_odds",
        available: true,
        kind: "最終",
        observedAtJst: "2026-11-07T15:04:00+09:00",
        reason: null,
        detail: null,
        horses: [
          { horseNumber: 1, selection: "1", odds: 3.1, oddsMin: null, oddsMax: null, status: null, kind: "最終", observedAtJst: "2026-11-07T15:04:00+09:00" },
          { horseNumber: 2, selection: "2", odds: null, oddsMin: 1.2, oddsMax: 1.8, status: null, kind: "最終", observedAtJst: null },
        ],
      },
    );
    expect(text).toBe(["# 単勝オッズ", "観測時刻: 2026-11-07T15:04:00+09:00", "種別: 最終", "1 ア: 3.1", "2 イ: 1.2〜1.8"].join("\n"));
    const empty = renderWinOddsText([{ horse_number: 1, horse_name: "ア" }], null);
    expect(empty).toBe(["# 単勝オッズ", "観測時刻: ", "種別: ", "1 ア: "].join("\n"));
  });
});

function horseOf(number: number, starts: number): CareerHorse {
  return { horseName: `馬${number}`, queryName: `馬${number}`, horseNumber: number, careerStarts: starts, unresolved: false };
}

function run(input: {
  date: string;
  track: string;
  number: number;
  surface: string;
  distance: number;
  place: number | null;
  status?: string;
  abnormality?: string;
  name?: string;
}): Record<string, unknown> {
  return {
    horse_name: input.name ?? "ア",
    race_meeting_date: input.date,
    race_track: input.track,
    race_number: input.number,
    surface: input.surface,
    distance: input.distance,
    official_result: input.place,
    entry_status: input.status ?? "finished",
    race_abnormality: input.abnormality ?? "異常なし",
  };
}
