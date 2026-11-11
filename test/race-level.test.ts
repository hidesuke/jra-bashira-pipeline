import { describe, expect, it } from "vitest";
import { keys, MemoryKv } from "../src/kv";
import { loadLlmTrace, saveLlmTrace } from "../src/llm-trace";
import { loadPredictInput, savePredictInput } from "../src/predict-input";
import {
  RACE_LEVEL_HEADING,
  RACE_LEVEL_MARKER,
  RACE_LEVEL_META_KEY,
  RACE_LEVEL_REASONS,
  RACE_LEVEL_UNKNOWN,
  loadRaceLevel,
  raceLevelApplies,
} from "../src/race-level";

const SHA = "ab".repeat(32);
const RACE_DATE = "2026-11-07";
const DISPLAY = "過去最高レースレベル 2.200（該当：2024-12-15 京都 G1 朝日杯フューチュリティステークス 2着）";

describe("race level applicability", () => {
  it.each([
    ["3歳未勝利の芝", { surface: "芝" }, true],
    ["3歳未勝利のダート", { surface: "ダート" }, true],
    ["グレードが空", { grade: "" }, true],
    ["新馬", { race_condition: "新馬" }, false],
    ["1勝クラス", { race_condition: "1勝クラス" }, false],
    ["オープン", { race_condition: "オープン" }, false],
    ["2歳", { race_type: "2歳" }, false],
    ["3歳以上", { race_type: "3歳以上" }, false],
    ["障害", { surface: "障害" }, false],
    ["G1", { grade: "G1" }, false],
    ["G2", { grade: "G2" }, false],
    ["G3", { grade: "G3" }, false],
    ["L", { grade: "L" }, false],
  ] as const)("%s", (_label, patch, applies) => {
    expect(raceLevelApplies(raceRow(patch))).toBe(applies);
  });

  it("does not apply when the race row is missing", () => {
    expect(raceLevelApplies(null)).toBe(false);
  });
});

describe("loadRaceLevel", () => {
  it("does not read KV or emit a section when the race does not apply", async () => {
    const kv = countingKv();
    await seed(kv.kv, "2026-11-06", { "馬名A|2023-04-01": horse(DISPLAY) });
    const loaded = await loadRaceLevel(kv.kv, raceRow({ race_condition: "新馬" }), [entry()], RACE_DATE, marked("制限"));
    expect(loaded.text).toBe("");
    expect(loaded.gaps).toEqual([]);
    expect(loaded.record).toMatchObject({
      applied: false,
      reason: RACE_LEVEL_REASONS.notApplicable,
      asof: null,
      horses: [],
      missing: 0,
    });
    expect(kv.gets.filter((key) => key.startsWith("c1:"))).toEqual([]);
  });

  it("does not read KV when the race system prompt has no marker", async () => {
    const kv = countingKv();
    await seed(kv.kv, "2026-11-06", { "馬名A|2023-04-01": horse(DISPLAY) });
    const loaded = await loadRaceLevel(kv.kv, raceRow(), [entry()], RACE_DATE, "マーカーの無いシステム");
    expect(loaded.text).toBe("");
    expect(loaded.record.reason).toBe(RACE_LEVEL_REASONS.promptWithoutC1);
    expect(loaded.record.applied).toBe(false);
    expect(kv.gets.filter((key) => key.startsWith("c1:"))).toEqual([]);
  });

  it("uses display verbatim and marks horses missing from the table", async () => {
    const kv = new MemoryKv();
    await seed(kv, "2026-11-06", {
      "馬名A|2023-04-01": horse(DISPLAY, 2.2),
      "取消馬|2023-02-02": horse("過去最高レースレベル 1.000（該当：使わない）"),
    });
    const loaded = await loadRaceLevel(
      kv,
      raceRow(),
      [
        entry({ horse_number: 2, horse_name: "馬名B", birth_date: "2023-01-01" }),
        entry({ horse_number: 1, horse_name: "馬名A", birth_date: "2023-04-01T00:00:00Z" }),
        entry({ horse_number: 4, horse_name: "取消馬", birth_date: "2023-02-02", race_abnormality: "出走取消" }),
        entry({ horse_number: 5, horse_name: "除外馬", birth_date: "2023-02-03", race_abnormality: "競走除外" }),
        entry({ horse_number: 3, horse_name: "生年月日なし", birth_date: null }),
      ],
      RACE_DATE,
      marked("制限"),
    );
    expect(loaded.gaps).toEqual([]);
    expect(loaded.record).toMatchObject({
      applied: true,
      reason: null,
      asof: "2026-11-06",
      dataThrough: "2026-11-05",
      featSha256: SHA,
      missing: 2,
    });
    expect(loaded.text).toBe(
      [
        RACE_LEVEL_HEADING,
        `1 馬名A: ${DISPLAY}`,
        `2 馬名B: ${RACE_LEVEL_UNKNOWN}`,
        `3 生年月日なし: ${RACE_LEVEL_UNKNOWN}`,
        "（基準: 確定データ 2026-11-05 まで）",
      ].join("\n"),
    );
    expect(loaded.text).not.toContain("取消馬");
    expect(loaded.text).not.toContain("除外馬");
    expect(loaded.text).not.toContain("1.000");
    expect(loaded.record.horses.map((horse) => horse.key)).toEqual(["馬名A|2023-04-01", "馬名B|2023-01-01", null]);
    expect(JSON.stringify(loaded.record)).not.toContain("source");
  });

  it("accepts an asof nine days before the meeting and rejects the day before that", async () => {
    const fresh = new MemoryKv();
    await seed(fresh, "2026-10-29", { "馬名A|2023-04-01": horse(DISPLAY) });
    const ok = await loadRaceLevel(fresh, raceRow(), [entry()], RACE_DATE, marked("制限"));
    expect(ok.record.reason).toBeNull();
    expect(ok.text).toContain(DISPLAY);

    const staleKv = countingKv();
    await seed(staleKv.kv, "2026-10-28", { "馬名A|2023-04-01": horse(DISPLAY) });
    const stale = await loadRaceLevel(staleKv.kv, raceRow(), [entry()], RACE_DATE, marked("制限"));
    expect(stale.record).toMatchObject({ applied: true, reason: RACE_LEVEL_REASONS.asofStale, asof: "2026-10-28", missing: 1 });
    expect(stale.text).toContain(`1 馬名A: ${RACE_LEVEL_UNKNOWN}`);
    expect(stale.text).not.toContain(DISPLAY);
    expect(stale.gaps[0]).toContain("2026-10-28");
    expect(stale.gaps[0]).toContain("9日前より古い");
    expect(staleKv.gets.filter((key) => key.startsWith("c1:"))).toEqual([RACE_LEVEL_META_KEY]);
  });

  it("rejects an asof on or after the meeting day without reading the feature table", async () => {
    for (const asof of ["2026-11-07", "2026-11-08"]) {
      const kv = countingKv();
      await seed(kv.kv, asof, { "馬名A|2023-04-01": horse(DISPLAY) });
      const loaded = await loadRaceLevel(kv.kv, raceRow(), [entry()], RACE_DATE, marked("制限"));
      expect(loaded.record.reason).toBe(RACE_LEVEL_REASONS.asofNotBeforeRace);
      expect(loaded.text).toContain(RACE_LEVEL_UNKNOWN);
      expect(loaded.text).not.toContain(DISPLAY);
      expect(loaded.gaps[0]).toContain("開催日以降");
      expect(kv.gets.filter((key) => key.startsWith("c1:"))).toEqual([RACE_LEVEL_META_KEY]);
    }
  });

  it("marks every horse unknown when meta is missing or unreadable", async () => {
    const missing = countingKv();
    await missing.kv.put("c1:v1:races", "{}");
    const noMeta = await loadRaceLevel(missing.kv, raceRow(), [entry(), entry({ horse_number: 2, horse_name: "馬名B" })], RACE_DATE, marked("制限"));
    expect(noMeta.record.reason).toBe(RACE_LEVEL_REASONS.metaMissing);
    expect(noMeta.record.missing).toBe(2);
    expect(noMeta.text).toContain("（基準: 確定データ 不明）");
    expect(noMeta.gaps).toEqual(["過去最高レースレベル（c1:v1:meta が無い）"]);
    expect(missing.gets).toEqual([RACE_LEVEL_META_KEY]);

    const broken = new MemoryKv();
    await broken.put(RACE_LEVEL_META_KEY, "{");
    const invalid = await loadRaceLevel(broken, raceRow(), [entry()], RACE_DATE, marked("制限"));
    expect(invalid.record).toMatchObject({ reason: RACE_LEVEL_REASONS.metaInvalid, asof: null, featSha256: null });
    expect(invalid.gaps[0]).toContain("読めない");
  });

  it("does not read a feature key that is not c1:v1:feat:{asof}", async () => {
    const kv = countingKv();
    await kv.kv.put("c1:v1:sw", "{\"secret\":true}");
    await kv.kv.put(
      RACE_LEVEL_META_KEY,
      JSON.stringify({
        asof: "2026-11-06",
        data_through: "2026-11-05",
        feat_key: "c1:v1:sw",
        feat_sha256: SHA,
      }),
    );
    const loaded = await loadRaceLevel(kv.kv, raceRow(), [entry()], RACE_DATE, marked("制限"));
    expect(loaded.record.reason).toBe(RACE_LEVEL_REASONS.metaInvalid);
    expect(kv.gets).toEqual([RACE_LEVEL_META_KEY]);
  });

  it("marks every horse unknown when the feature table is missing or broken", async () => {
    const missing = countingKv();
    await missing.kv.put(RACE_LEVEL_META_KEY, JSON.stringify(meta("2026-11-06")));
    const noFeat = await loadRaceLevel(missing.kv, raceRow(), [entry()], RACE_DATE, marked("制限"));
    expect(noFeat.record).toMatchObject({
      reason: RACE_LEVEL_REASONS.featMissing,
      asof: "2026-11-06",
      dataThrough: "2026-11-05",
      featSha256: SHA,
      missing: 1,
    });
    expect(noFeat.gaps[0]).toContain("c1:v1:feat:2026-11-06 が無い");

    const broken = new MemoryKv();
    await broken.put(RACE_LEVEL_META_KEY, JSON.stringify(meta("2026-11-06")));
    await broken.put("c1:v1:feat:2026-11-06", "{\"asof\":\"2026-11-01\"}");
    const invalid = await loadRaceLevel(broken, raceRow(), [entry()], RACE_DATE, marked("制限"));
    expect(invalid.record.reason).toBe(RACE_LEVEL_REASONS.featInvalid);
    expect(invalid.text).toContain(RACE_LEVEL_UNKNOWN);
    expect(invalid.text).not.toContain(DISPLAY);
  });

  it("drops a display that contains a placeholder so the user template can still be filled", async () => {
    const kv = new MemoryKv();
    await seed(kv, "2026-11-06", { "馬名A|2023-04-01": horse("過去最高 {{race_level}}") });
    const loaded = await loadRaceLevel(kv, raceRow(), [entry()], RACE_DATE, marked("制限"));
    expect(loaded.text).toContain(RACE_LEVEL_UNKNOWN);
    expect(loaded.text).not.toContain("{{");
    expect(loaded.gaps).toEqual(["過去最高レースレベル（表示に差し込み記号がある馬がある）"]);
    expect(loaded.record.horses[0]?.fromTable).toBe(false);
  });

  it("keeps a scratched runner out and still lists a non-scratch abnormality", async () => {
    const kv = new MemoryKv();
    await seed(kv, "2026-11-06", {});
    const loaded = await loadRaceLevel(
      kv,
      raceRow(),
      [
        entry({ horse_name: "発走除外馬", race_abnormality: "発走除外" }),
        entry({ horse_number: 8, horse_name: "中止馬", race_abnormality: "競走中止" }),
      ],
      RACE_DATE,
      marked("制限"),
    );
    expect(loaded.record.horses.map((horse) => horse.horseName)).toEqual(["中止馬"]);
  });
});

describe("race level records", () => {
  it("round-trips on the existing predict input and trace keys", async () => {
    const kv = countingKv();
    await seed(kv.kv, "2026-11-06", { "馬名A|2023-04-01": horse(DISPLAY) });
    const loaded = await loadRaceLevel(kv.kv, raceRow(), [entry()], RACE_DATE, marked("制限"));
    await savePredictInput(kv.kv, {
      raceKey: "20261107-03-11",
      runId: "run",
      umabashira: `馬柱\n\n${loaded.text}`,
      raceInput: "ユーザー",
      horses: [],
      raceLevel: loaded.record,
    });
    await saveLlmTrace(kv.kv, "20261107-03-11", { courseOutput: "コース" });
    await saveLlmTrace(kv.kv, "20261107-03-11", { raceOutput: "レース", raceLevel: loaded.record });
    await saveLlmTrace(kv.kv, "20261107-03-11", { raceWebSearchQueries: [] });
    expect((await loadPredictInput(kv.kv, "20261107-03-11"))?.raceLevel).toEqual(loaded.record);
    expect((await loadLlmTrace(kv.kv, "20261107-03-11"))?.raceLevel).toEqual(loaded.record);
    const names = [...(await kv.kv.list()).keys.map((key) => key.name)];
    expect(names.filter((name) => name.startsWith("c1:")).sort()).toEqual(["c1:v1:feat:2026-11-06", "c1:v1:meta"]);
    const saved = names.filter((name) => name.startsWith("input:v1:") || name.startsWith("trace:v1:")).sort();
    expect(saved).toEqual([keys.llmTrace("20261107-03-11"), keys.predictInput("20261107-03-11")].sort());
    expect(kv.puts.filter((key) => key.startsWith("c1:")).sort()).toEqual(["c1:v1:feat:2026-11-06", "c1:v1:meta"]);
  });

  it("loads older saves without a race level as null", async () => {
    const kv = new MemoryKv();
    await savePredictInput(kv, { raceKey: "20261107-03-11", runId: "run", umabashira: "馬柱", raceInput: "ユーザー", horses: [] });
    await saveLlmTrace(kv, "20261107-03-11", { raceOutput: "レース" });
    expect((await loadPredictInput(kv, "20261107-03-11"))?.raceLevel).toBeNull();
    expect((await loadLlmTrace(kv, "20261107-03-11"))?.raceLevel).toBeNull();
  });
});

function raceRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { race_type: "3歳", race_condition: "未勝利", grade: "平場", surface: "芝", ...patch };
}

function entry(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { horse_number: 1, horse_name: "馬名A", birth_date: "2023-04-01", ...patch };
}

function marked(text: string): string {
  return `${text}\n${RACE_LEVEL_MARKER}`;
}

function horse(display: string, maxSw: number | null = 2.2): Record<string, unknown> {
  return { max_Sw: maxSw, missing: false, display, source: { kind: "race" } };
}

function meta(asof: string): Record<string, unknown> {
  return {
    asof,
    data_through: "2026-11-05",
    data_version: "test",
    built_at: "2026-11-06T00:00:00Z",
    feat_key: `c1:v1:feat:${asof}`,
    feat_sha256: SHA,
    builder: "test",
  };
}

async function seed(kv: MemoryKv, asof: string, horses: Record<string, unknown>): Promise<void> {
  await kv.put(RACE_LEVEL_META_KEY, JSON.stringify(meta(asof)));
  await kv.put(`c1:v1:feat:${asof}`, JSON.stringify({ asof, horses }));
}

function countingKv(): { kv: MemoryKv; gets: string[]; puts: string[] } {
  const kv = new MemoryKv();
  const gets: string[] = [];
  const puts: string[] = [];
  const originalGet = kv.get.bind(kv);
  const originalPut = kv.put.bind(kv);
  kv.get = async (key: string) => {
    gets.push(key);
    return originalGet(key);
  };
  kv.put = async (key: string, value: string, options?: { expirationTtl?: number }) => {
    puts.push(key);
    return originalPut(key, value, options);
  };
  return { kv, gets, puts };
}
