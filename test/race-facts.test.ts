import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fillRaceUser, RACE_USER_PLACEHOLDERS } from "../src/dify-input";
import { loadInspectView, renderInspectMarkdown } from "../src/inspect";
import type { JobState } from "../src/job";
import { saveJob } from "../src/job";
import { MemoryKv } from "../src/kv";
import { savePredictInput } from "../src/predict-input";
import { buildRaceFacts, MISSING_INNER_OUTER, MISSING_TEMPORARY_RAIL } from "../src/race-facts";
import { horseFactGaps, renderUmabashira } from "../src/umabashira";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const card = JSON.parse(readFileSync(join(fixtureDir, "fixtures/20261108-05-11-race.json"), "utf8")) as {
  race_key: string;
  race: Record<string, unknown>;
  entries: Record<string, unknown>[];
};

const race = {
  raceKey: card.race_key,
  raceId: card.race_key,
  date: "2026-11-08",
  venue: "東京",
  venueCode: "05",
  raceNumber: 11,
};

describe("20261108 Tokyo 11R race facts", () => {
  const facts = buildRaceFacts({ raceRow: card.race, entries: card.entries });
  const umabashira = renderUmabashira({ race, entries: card.entries, formTasks: [] });

  it("puts the race card into the prediction input and leaves course direction blank", () => {
    expect(facts.text).toContain("レース名: アルゼンチン共和国杯");
    expect(facts.text).toContain("グレード: G2");
    expect(facts.text).toContain("クラス: オープン");
    expect(facts.text).toContain("競走種別: 3歳以上");
    expect(facts.text).toContain("頭数: 予定18 / 出走18（取消・除外を反映）");
    expect(facts.text).toContain("コース: Bコース");
    expect(facts.text).toContain("内外回り: \n仮柵: ");
    expect(facts.text).toContain("斤量種別: ハンデ");
    expect(facts.text).toContain("発走時刻: 15:30");
    expect(facts.text).not.toMatch(/オッズ|単勝|人気/);
    expect(facts.gaps).toEqual([MISSING_INNER_OUTER, MISSING_TEMPORARY_RAIL]);
    expect(umabashira).toContain("調教師 堀　宣行（美浦）");
    expect(umabashira).toContain("馬体重 480kg（+4）");
    expect(umabashira).toContain("調教師 田中　克典（栗東）");
    expect(umabashira).toContain("馬体重 506kg（-10）");
    expect(umabashira).toContain("馬体重 496kg（0）");
    expect(horseFactGaps(card.entries)).toEqual([]);
  });

  it("is visible from /admin/inspect when the prompt has not added the placeholder yet", async () => {
    const user = fillRaceUser(
      [RACE_USER_PLACEHOLDERS.umabashira, RACE_USER_PLACEHOLDERS.weather].join("\n"),
      {
        race_facts: facts.text,
        umabashira,
        course_analysis: "コース本文",
        weather: "晴",
        condition: "良",
        remarks: "なし",
        past_runs: "",
        course_records: "",
        runner_stats: "",
        win_odds: "",
      },
    );
    expect(user.startsWith("# レース情報")).toBe(true);
    expect(user).toContain("アルゼンチン共和国杯");
    expect(user).toContain("調教師 堀　宣行（美浦）");
    expect(user).not.toContain("{{");
    const placed = fillRaceUser(`前置き\n${RACE_USER_PLACEHOLDERS.race_facts}\n後`, {
      race_facts: facts.text,
      umabashira: "",
      course_analysis: "",
      weather: "",
      condition: "",
      remarks: "",
      past_runs: "",
      course_records: "",
      runner_stats: "",
      win_odds: "",
    });
    expect(placed.startsWith("前置き\n# レース情報")).toBe(true);
    expect(placed.indexOf("# レース情報")).toBe(placed.lastIndexOf("# レース情報"));

    const kv = new MemoryKv();
    const gaps = [...facts.gaps, ...horseFactGaps(card.entries)];
    const state: JobState = {
      runId: "run-fixture",
      race,
      requestedBy: "test",
      phase: "done",
      remarks: "",
      baba: null,
      raceRow: card.race,
      entries: card.entries,
      formTasks: [],
      odds: null,
      courseVariant: null,
      statTasks: [],
      prediction: null,
      notionPageId: null,
      raceInputGaps: gaps,
      updatedAt: "2026-11-08T07:00:00.000Z",
    };
    await saveJob(kv, state);
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: state.runId,
      umabashira,
      raceInput: user,
      horses: [],
    });
    const view = await loadInspectView(kv, race.raceKey);
    expect(view?.race_prediction.user_text).toContain("レース名: アルゼンチン共和国杯");
    expect(view?.race_prediction.user_text).toContain("馬体重 506kg（-10）");
    expect(view?.umabashira).toContain("調教師 宮田　敬介（美浦）");
    expect(view?.race_input_gaps).toEqual([MISSING_INNER_OUTER, MISSING_TEMPORARY_RAIL]);
    const markdown = renderInspectMarkdown(view!);
    expect(markdown).toContain("アルゼンチン共和国杯");
    expect(markdown).toContain(MISSING_INNER_OUTER);
    expect(facts.text).not.toContain("単勝");
  });

  it("keeps going when the race name and horse weight are missing", () => {
    const row = { ...card.race, race_name_main: null, post_time: null, starters: null };
    const entries = [
      { horse_number: 1, horse_name: "ア", trainer_name: "調教師A", race_abnormality: "出走取消" },
      { horse_number: 2, horse_name: "イ", trainer_east_west: "東", horse_weight: 450 },
    ];
    const partial = buildRaceFacts({ raceRow: row, entries });
    expect(partial.text).toContain("レース名: \n");
    expect(partial.text).toContain("グレード: G2");
    expect(partial.text).toContain("発走時刻: \n");
    expect(partial.text).toContain("頭数: 予定18 / 出走1（取消・除外を反映。starters が空なので出馬表から数えた）");
    expect(partial.gaps).toEqual([
      MISSING_INNER_OUTER,
      MISSING_TEMPORARY_RAIL,
      "レース名",
      "出走頭数（starters）",
      "発走時刻",
    ]);
    expect(horseFactGaps(entries)).toEqual(["1 アの調教師の所属", "1 アの馬体重", "2 イの調教師"]);
    const page = renderUmabashira({ race, entries, formTasks: [] });
    expect(page).toContain("調教師 調教師A");
    expect(page).toContain("馬体重 —");
    expect(page).toContain("調教師 —");
    expect(page).toContain("馬体重 450kg（増減—）");
    expect(page).toContain("出走取消");
  });
});
