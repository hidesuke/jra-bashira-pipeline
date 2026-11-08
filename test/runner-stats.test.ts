import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import { catalogFromTools } from "../src/schema";
import { MemoryKv } from "../src/kv";
import {
  EXPECTED_RUNNER_SCOPE,
  jockeyCourseCacheKey,
  jockeyStatsArgs,
  pedigreeStatsArgs,
  qualifiedRequeryName,
  collectRunnerStats,
  RUNNER_STATS_CALL_LIMIT,
} from "../src/runner-stats";
import { bashiraTools } from "./fixture";

const catalog = catalogFromTools(bashiraTools);
const course = { venue: "京都", surface: "ダート", distance: 1800, period: { from: "2021-11-07", to: "2026-11-07" } };

function namesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function grouped(field: string, rows: Array<[string, number, number, number]>, resolutions?: unknown[]): Record<string, unknown> {
  const queries = resolutions ? null : rows.map(([name]) => name);
  return {
    columns: [field, "starts", "wins", "top3"],
    rows,
    scope: EXPECTED_RUNNER_SCOPE,
    data_through: "2026-11-03",
    data_version: "20261108T091910Z",
    truncated: false,
    name_resolution:
      resolutions ??
      queries!.map((name) => ({ field, query: name, status: "resolved", candidates: [{ name, starts: 10 }] })),
  };
}

function jockeyRow(name: string, starts = 40, wins = 8, top3 = 15): unknown {
  return {
    columns: ["starts", "wins", "top3"],
    rows: [[starts, wins, top3]],
    scope: EXPECTED_RUNNER_SCOPE,
    data_through: "2026-11-03",
    data_version: "20261108T091910Z",
    truncated: false,
    name_resolution: [{ field: "jockey_name", query: name, status: "resolved", candidates: [{ name, starts: 100 }] }],
  };
}

function port(handler: (args: Record<string, unknown>) => unknown): BashiraPort & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async listTools() {
      return { ok: true, tools: bashiraTools };
    },
    async callTool() {
      return { ok: false, code: "upstream", retryable: true, message: "単発は使わない" };
    },
    async callTools(batch) {
      return {
        ok: true,
        results: batch.map((call) => {
          calls.push(call.args);
          return handler(call.args);
        }),
      };
    },
  };
}

const baseInput = {
  catalog,
  venue: "京都",
  surface: "ダート",
  distance: 1800,
  raceDate: "2026-11-08",
  periodYears: 5,
  minCount: 30,
  now: "2026-11-08T01:00:00.000Z",
};

describe("runner stats", () => {
  it("does not ask for payout, popularity, or min_starts", () => {
    const blob = JSON.stringify([
      pedigreeStatsArgs(course, "sire_name", ["父一", "父二"]),
      pedigreeStatsArgs(course, "broodmare_sire_name", ["母父一"]),
      jockeyStatsArgs(course, "騎手A"),
    ]);
    expect(blob).not.toContain("min_starts");
    expect(blob).not.toContain("win_payout");
    expect(blob).not.toContain("win_odds_rank");
    expect(blob).toContain("2021-11-07");
    expect(blob).toContain("2026-11-07");
    expect(RUNNER_STATS_CALL_LIMIT).toBe(24);
  });

  it("picks a birth year only when one candidate is the same name", () => {
    expect(qualifiedRequeryName("同名", [{ name: "同名 (1994)" }, { name: "別馬" }])).toBe("同名 (1994)");
    expect(qualifiedRequeryName("同名", [{ name: "同名 (1994)" }, { name: "同名 (2001)" }])).toBeNull();
    expect(qualifiedRequeryName("キング", [{ name: "キングカメハメハ" }, { name: "キングヘイロー" }])).toBeNull();
  });

  it("computes rates, keeps a real zero, and does not turn a miss into zero", async () => {
    const kv = new MemoryKv();
    const bashira = port((args) => {
      const filters = args.filters as Record<string, unknown>;
      if ("jockey_name" in filters) return jockeyRow(String(filters.jockey_name), 4, 1, 2);
      if ("broodmare_sire_name" in filters) {
        return {
          ...grouped("broodmare_sire_name", [["母父一", 10, 1, 3]]),
          name_resolution: [
            { field: "broodmare_sire_name", query: "母父一", status: "resolved", candidates: [{ name: "母父一", starts: 10 }] },
            { field: "broodmare_sire_name", query: "無い母父", status: "not_found", candidates: [] },
          ],
        };
      }
      return {
        columns: ["sire_name", "starts", "wins", "top3"],
        rows: [["父一", 48, 8, 20]],
        scope: EXPECTED_RUNNER_SCOPE,
        data_through: "2026-11-03",
        data_version: "20261108T091910Z",
        name_resolution: [
          { field: "sire_name", query: "父一", status: "resolved", candidates: [{ name: "父一", starts: 10 }] },
          { field: "sire_name", query: "ゼロ父", status: "resolved", candidates: [{ name: "ゼロ父", starts: 1 }] },
          { field: "sire_name", query: "欠け父", status: "resolved", candidates: [{ name: "欠け父", starts: 1 }] },
        ],
      };
    });
    const result = await collectRunnerStats({
      ...baseInput,
      bashira,
      kv,
      entries: [
        { horse_number: 2, horse_name: "イ", sire_name: "ゼロ父", broodmare_sire_name: "無い母父", jockey_name: "騎手A" },
        { horse_number: 1, horse_name: "ア", sire_name: "父一", broodmare_sire_name: "母父一", jockey_name: "騎手A" },
        { horse_number: 3, horse_name: "ウ", sire_name: "欠け父", broodmare_sire_name: "母父一", jockey_name: null },
        { horse_number: 4, horse_name: "エ", sire_name: "父一", race_abnormality: "出走取消", jockey_name: "騎手B" },
      ],
    });
    expect(result.scope).toBe(EXPECTED_RUNNER_SCOPE);
    expect(result.text).toContain("期間: 2021-11-07〜2026-11-07（レース日の前日までの過去5年）");
    expect(result.text).toContain("scope: jra_and_non_jra。条件の競馬場名は中央の開催場");
    expect(result.text).toContain("### 1 ア");
    expect(result.text.indexOf("### 1 ア")).toBeLessThan(result.text.indexOf("### 2 イ"));
    expect(result.text).toContain("父 父一: 出走 48　勝ち 8　勝率 16.7%　複勝 20　複勝率 41.7%");
    expect(result.text).toContain("父 ゼロ父: 出走 0　勝ち 0　勝率 —　複勝 0　複勝率 — 件数が少ないため参考値");
    expect(result.text).toContain("母父 無い母父: 名前が見つからない");
    expect(result.text).not.toContain("母父 無い母父: 出走 0");
    expect(result.text).toContain("騎手 騎手A: 出走 4　勝ち 1　勝率 25.0%　複勝 2　複勝率 50.0% 件数が少ないため参考値");
    expect(result.text).toContain("騎手: 出馬表に無い");
    expect(result.text).not.toContain("エ");
    expect(result.text).not.toContain("騎手B");
    expect(result.gaps).toContain("2 イ の母父 無い母父（名前が見つからない）");
    expect(result.gaps).toContain("3 ウ の騎手（出馬表に無い）");
    expect(result.gaps.join("\n")).not.toContain("scope");
  });

  it("does not read a row when wins is missing", async () => {
    const bashira = port((args) => {
      const filters = args.filters as Record<string, unknown>;
      if ("jockey_name" in filters) return jockeyRow(String(filters.jockey_name));
      if ("broodmare_sire_name" in filters) return grouped("broodmare_sire_name", [["母父一", 40, 4, 10]]);
      return {
        columns: ["sire_name", "starts"],
        rows: [["父一", 10]],
        scope: EXPECTED_RUNNER_SCOPE,
        data_version: "20261108T091910Z",
        name_resolution: [{ field: "sire_name", query: "父一", status: "resolved", candidates: [{ name: "父一", starts: 1 }] }],
      };
    });
    const result = await collectRunnerStats({
      ...baseInput,
      bashira,
      kv: new MemoryKv(),
      entries: [{ horse_number: 1, horse_name: "ア", sire_name: "父一", broodmare_sire_name: "母父一", jockey_name: "騎手A" }],
    });
    expect(result.text).toContain("父 父一: 取得できず（件数を読めません）");
    expect(result.text).not.toContain("父 父一: 出走 10");
    expect(result.gaps).toContain("1 ア の父 父一（件数を読めません）");
  });

  it("re-queries a single birth year and ignores rows from an aborted call", async () => {
    let sireCalls = 0;
    const bashira = port((args) => {
      const filters = args.filters as Record<string, unknown>;
      if ("jockey_name" in filters) return jockeyRow(String(filters.jockey_name));
      if ("broodmare_sire_name" in filters) return grouped("broodmare_sire_name", [["母父一", 40, 4, 10]]);
      sireCalls += 1;
      const names = namesOf(filters.sire_name);
      if (sireCalls === 1) {
        return {
          columns: ["sire_name", "starts", "wins", "top3"],
          rows: [["父一", 99, 99, 99]],
          scope: EXPECTED_RUNNER_SCOPE,
          data_version: "20261108T091910Z",
          note: "絞り込みを実行していません",
          name_resolution: [
            { field: "sire_name", query: "父一", status: "resolved", candidates: [{ name: "父一", starts: 10 }] },
            {
              field: "sire_name",
              query: "同名",
              status: "ambiguous",
              candidates: [{ name: "同名 (1994)", starts: 4, period: "2000〜2010" }],
            },
            {
              field: "sire_name",
              query: "二つ",
              status: "ambiguous",
              candidates: [
                { name: "二つ (1990)", starts: 2 },
                { name: "二つ (2000)", starts: 2 },
              ],
            },
          ],
        };
      }
      expect(names).toEqual(["父一", "同名 (1994)"]);
      expect(names).not.toContain("二つ");
      return grouped("sire_name", [
        ["父一", 48, 8, 20],
        ["同名 (1994)", 6, 1, 2],
      ]);
    });
    const result = await collectRunnerStats({
      ...baseInput,
      bashira,
      kv: new MemoryKv(),
      entries: [
        { horse_number: 1, horse_name: "ア", sire_name: "父一", broodmare_sire_name: "母父一", jockey_name: "騎手A" },
        { horse_number: 2, horse_name: "イ", sire_name: "同名", broodmare_sire_name: "母父一", jockey_name: "騎手A" },
        { horse_number: 3, horse_name: "ウ", sire_name: "二つ", broodmare_sire_name: "母父一", jockey_name: "騎手A" },
      ],
    });
    expect(sireCalls).toBe(2);
    expect(result.text).toContain("父 父一: 出走 48");
    expect(result.text).not.toContain("出走 99");
    expect(result.text).toContain("父 同名 (1994): 出走 6　勝ち 1　勝率 16.7%　複勝 2　複勝率 33.3% 件数が少ないため参考値");
    expect(result.text).toContain("父 二つ: 同名のため特定できない");
    expect(result.text).not.toContain("父 二つ: 出走 0");
    expect(result.gaps).toContain("3 ウ の父 二つ（同名のため特定できない）");
  });

  it("reuses a jockey cache for the same course and data_version", async () => {
    const kv = new MemoryKv();
    const bashira = port((args) => {
      const filters = args.filters as Record<string, unknown>;
      if ("jockey_name" in filters) return jockeyRow(String(filters.jockey_name));
      if ("sire_name" in filters) return grouped("sire_name", namesOf(filters.sire_name).map((name) => [name, 40, 4, 10]));
      return grouped("broodmare_sire_name", namesOf(filters.broodmare_sire_name).map((name) => [name, 40, 4, 10]));
    });
    const entries = [{ horse_number: 1, horse_name: "ア", sire_name: "父一", broodmare_sire_name: "母父一", jockey_name: "騎手A" }];
    const first = await collectRunnerStats({ ...baseInput, bashira, kv, entries });
    const jockeyCalls = () => bashira.calls.filter((args) => "jockey_name" in (args.filters as object));
    expect(jockeyCalls()).toHaveLength(1);
    expect(first.cacheHits).toBe(0);
    const key = jockeyCourseCacheKey({ ...course, dataVersion: "20261108T091910Z", jockey: "騎手A" });
    expect(await kv.get(key)).toContain("騎手A");
    const second = await collectRunnerStats({ ...baseInput, bashira, kv, entries });
    expect(jockeyCalls()).toHaveLength(1);
    expect(second.cacheHits).toBe(1);
    expect(second.text).toContain("騎手 騎手A: 出走 40");
    expect(second.calls).toBe(2);
  });

  it("passes what fits in the call limit and records the rest", async () => {
    const bashira = port((args) => {
      const filters = args.filters as Record<string, unknown>;
      if ("sire_name" in filters) return grouped("sire_name", [["父一", 48, 8, 20]]);
      if ("broodmare_sire_name" in filters) return grouped("broodmare_sire_name", [["母父一", 40, 4, 10]]);
      return jockeyRow(String(filters.jockey_name));
    });
    const result = await collectRunnerStats({
      ...baseInput,
      bashira,
      kv: new MemoryKv(),
      callLimit: 1,
      entries: [{ horse_number: 1, horse_name: "ア", sire_name: "父一", broodmare_sire_name: "母父一", jockey_name: "騎手A" }],
    });
    expect(result.calls).toBe(1);
    expect(bashira.calls).toHaveLength(1);
    expect(result.text).toContain("父 父一: 出走 48");
    expect(result.text).toContain("母父 母父一: 取得できず（呼び出し上限のため取得していない）");
    expect(result.text).toContain("騎手 騎手A: 取得できず（呼び出し上限のため取得していない）");
    expect(result.text).not.toContain("母父 母父一: 出走 0");
    expect(result.gaps).toContain("1 ア の母父 母父一（呼び出し上限のため取得していない）");
  });

  it("keeps going when get_stats fails and records an unexpected scope", async () => {
    const failing: BashiraPort = {
      async listTools() {
        return { ok: true, tools: bashiraTools };
      },
      async callTool() {
        return { ok: false, code: "upstream", retryable: true, message: "no" };
      },
      async callTools() {
        return { ok: false, code: "upstream", retryable: true, message: "集計が落ちました", results: [] };
      },
    };
    const failed = await collectRunnerStats({
      ...baseInput,
      bashira: failing,
      kv: new MemoryKv(),
      entries: [{ horse_number: 1, horse_name: "ア", sire_name: "父一", broodmare_sire_name: "母父一", jockey_name: "騎手A" }],
    });
    expect(failed.text).toContain("取得できず（集計が落ちました）");
    expect(failed.text).not.toContain("出走 0");
    expect(failed.gaps.length).toBeGreaterThan(0);

    const scoped = port((args) => {
      const filters = args.filters as Record<string, unknown>;
      const payload = (
        "jockey_name" in filters
          ? jockeyRow(String(filters.jockey_name))
          : "sire_name" in filters
            ? grouped("sire_name", [["父一", 40, 4, 10]])
            : grouped("broodmare_sire_name", [["母父一", 40, 4, 10]])
      ) as { scope: string };
      return { ...payload, scope: "jra_only" };
    });
    const result = await collectRunnerStats({
      ...baseInput,
      bashira: scoped,
      kv: new MemoryKv(),
      entries: [{ horse_number: 1, horse_name: "ア", sire_name: "父一", broodmare_sire_name: "母父一", jockey_name: "騎手A" }],
    });
    expect(result.text).toContain("父 父一: 出走 40");
    expect(result.text).toContain("scope: jra_only");
    expect(result.gaps).toContain("出走馬のコース成績（get_stats の scope が jra_and_non_jra ではありません: jra_only）");
  });
});
