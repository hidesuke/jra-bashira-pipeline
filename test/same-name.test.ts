import { describe, expect, it } from "vitest";
import { checkPredictionConsistency } from "../src/consistency";
import {
  entryFacts,
  finishQualifiedFetch,
  horseFormSnapshots,
  planFormFetch,
  sameNameUnavailableNote,
  type FormTask,
} from "../src/form";
import { ambiguousNameMessage } from "../src/bashira/mcp";
import { MemoryKv } from "../src/kv";
import { loadPredictInput, PREDICT_INPUT_CHUNK_CHARS, PREDICT_INPUT_MAX_CHARS, savePredictInput } from "../src/predict-input";
import { renderUmabashira } from "../src/umabashira";
import type { RaceRef } from "../src/types";

const race: RaceRef = {
  raceKey: "20261108-05-11",
  raceId: "20261108-05-11",
  date: "2026-11-08",
  venue: "東京",
  venueCode: "05",
  raceNumber: 11,
};

const ambiguous = {
  row_count: 0,
  rows: [],
  name_resolution: [
    {
      field: "horse_name",
      query: "マイネルエンペラー",
      status: "ambiguous",
      candidates: [
        { name: "マイネルエンペラー (2020)", period: "2022〜2026", starts: 26 },
        { name: "マイネルエンペラー (1993)", period: "1995〜1996", starts: 99 },
      ],
    },
  ],
};

function task(name: string, facts: Record<string, unknown>): FormTask {
  return {
    horseName: name,
    horseNumber: 3,
    status: "pending",
    args: { filters: { horse_name: name, race_meeting_date: { lte: race.date } }, columns: ["horse_name"], limit: 12 },
    rows: [],
    facts: entryFacts(facts),
  };
}

describe("same-name past runs", () => {
  it("picks the candidate whose birth year matches, not the one with more starts", () => {
    expect(ambiguousNameMessage(ambiguous)).toMatch(/曖昧/);
    expect(ambiguousNameMessage({ name_resolution: [{ field: "horse_name", status: "resolved", candidates: [{ name: "ドウデュース", starts: 14 }] }] })).toBeNull();
    const emperor = task("マイネルエンペラー", {
      birth_date: "2020-03-13T00:00:00Z",
      career_starts: 26,
      prev_official_result: 2,
      prev_distance: 2400,
      prev_surface: "芝",
      days_since_last_race: 35,
      weight_to_carry_kg: 58.5,
    });
    const plan = planFormFetch(emperor, ambiguous, race);
    expect(plan.kind).toBe("requery");
    if (plan.kind !== "requery") return;
    expect(plan.qualifiedName).toBe("マイネルエンペラー (2020)");
    expect((plan.args.filters as { horse_name: string }).horse_name).toBe("マイネルエンペラー (2020)");
    const done = finishQualifiedFetch(
      emperor,
      {
        name_resolution: [{ field: "horse_name", status: "resolved", candidates: [{ name: plan.qualifiedName, starts: 26 }] }],
        rows: [
          {
            horse_name: "マイネルエンペラー",
            race_meeting_date: "2026-11-08T00:00:00Z",
            race_track: "東京",
            race_number: 11,
            entry_status: "upcoming",
          },
          {
            horse_name: "マイネルエンペラー (2020)",
            race_meeting_date: "2026-10-04",
            race_track: "京都",
            race_name_main: "京都大賞典",
            official_result: 2,
            entry_status: "finished",
          },
        ],
      },
      race,
      plan.qualifiedName,
      plan.candidates,
    );
    expect(done.resolution).toMatchObject({ status: "resolved_by_birth_year", resolvedName: "マイネルエンペラー (2020)", birthYear: 2020 });
    expect(done.rows.map((row) => row.race_name_main)).toEqual(["京都大賞典"]);
    const older = planFormFetch(task("マイネルエンペラー", { birth_date: "1993-04-01" }), ambiguous, race);
    expect(older.kind).toBe("requery");
    if (older.kind === "requery") expect(older.qualifiedName).toBe("マイネルエンペラー (1993)");
  });

  it("does not present an unresolved same-name horse as having no record", () => {
    const ghost = task("ゴースト", {
      birth_date: "2018-01-01",
      career_starts: 11,
      prev_official_result: 5,
      prev_distance: 1800,
      prev_surface: "ダート",
      days_since_last_race: 21,
    });
    const plan = planFormFetch(ghost, ambiguous, race);
    expect(plan.kind).toBe("done");
    if (plan.kind !== "done") return;
    expect(plan.task.resolution?.status).toBe("unresolved");
    expect(plan.task.rows).toEqual([]);
    expect(plan.task.note).toBe(sameNameUnavailableNote(ghost.facts));
    expect(plan.task.note).toContain("同名馬のため近走取得不可");
    expect(plan.task.note).toContain("通算出走数 11");
    expect(plan.task.note).toContain("前走着順 5着");
    expect(plan.task.note).toContain("前走距離 1800m");
    expect(plan.task.note).toContain("前走馬場 ダート");
    expect(plan.task.note).toContain("間隔 21日");
    const page = renderUmabashira({
      race,
      entries: [{ horse_number: 3, horse_name: "ゴースト" }],
      formTasks: [plan.task],
    });
    expect(page).toContain("同名馬のため近走取得不可");
    expect(page).not.toMatch(/ゴースト[\s\S]{0,160}近走なし/);
  });
});

describe("prediction consistency", () => {
  it("warns when ミラージュナイト's 目黒記念 is written as 2着 instead of 4着", () => {
    const [horse] = horseFormSnapshots(
      [{ horse_number: 4, horse_name: "ミラージュナイト", birth_date: "2022-03-30", weight_to_carry_kg: 57, career_starts: 12 }],
      [
        {
          horseName: "ミラージュナイト",
          horseNumber: 4,
          status: "done",
          args: {},
          rows: [{ race_name_main: "目黒記念", official_result: 4, race_meeting_date: "2026-05-31", surface: "芝", distance: 2500 }],
          resolution: { status: "unique", resolvedName: "ミラージュナイト", birthYear: 2022, candidates: [] },
          facts: entryFacts({ birth_date: "2022-03-30", weight_to_carry_kg: 57, career_starts: 12 }),
        },
      ],
    );
    expect(horse?.pastRunCount).toBe(1);
    const wrong = checkPredictionConsistency("ミラージュナイトは目黒記念で2着。今回斤量 57 kg。", [horse!]);
    expect(wrong).toEqual([
      {
        horseName: "ミラージュナイト",
        kind: "finish",
        raceName: "目黒記念",
        claimed: "2着",
        actual: "4着",
        snippet: "目黒記念で2着",
        message: "ミラージュナイトの目黒記念は4着だが、予想本文は2着と書いている: 「目黒記念で2着」",
      },
    ]);
    expect(checkPredictionConsistency("ミラージュナイトは目黒記念で4着。今回斤量 57 kg。", [horse!])).toEqual([]);
    const weight = checkPredictionConsistency("ミラージュナイトは目黒記念で4着。今回斤量 55 kg。", [horse!]);
    expect(weight.map((warning) => warning.kind)).toEqual(["weight"]);
  });
});

describe("predict input storage", () => {
  it("round-trips a long umabashira in chunks and truncates past the cap", async () => {
    const kv = new MemoryKv();
    const umabashira = `馬柱${"あ".repeat(PREDICT_INPUT_CHUNK_CHARS)}`;
    const saved = await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-1",
      umabashira,
      raceInput: "入力",
      horses: [],
    });
    expect(saved.truncated).toBe(false);
    const loaded = await loadPredictInput(kv, race.raceKey);
    expect(loaded?.umabashira).toBe(umabashira);
    expect(loaded?.raceInput).toBe("入力");
    const huge = "う".repeat(PREDICT_INPUT_MAX_CHARS + 20);
    const clipped = await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-1",
      umabashira: huge,
      raceInput: "入力",
      horses: [],
    });
    expect(clipped.truncated).toBe(true);
    const again = await loadPredictInput(kv, race.raceKey);
    expect(again?.umabashira.endsWith("切り詰め）")).toBe(true);
    expect(again?.umabashira.includes("う".repeat(PREDICT_INPUT_MAX_CHARS))).toBe(true);
    expect(again?.umabashira.includes("う".repeat(PREDICT_INPUT_MAX_CHARS + 1))).toBe(false);
    expect(again?.raceInput).toBe("入力");
  });
});
