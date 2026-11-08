import type { BashiraPort } from "./bashira/port";
import { readNameResolutions, type NameResolutionEntry } from "./bashira/mcp";
import { courseSummaryPeriod, formatRate } from "./course-summary";
import { yearInQualifiedName } from "./form";
import { payloadNote, rowsToObjects, stringField, numberField } from "./rows";
import { assertFields, assertToolArgs, type ToolCatalog } from "./schema";
import { STATS_BATCH_SIZE, STATS_CACHE_TTL_SECONDS, type KvStore } from "./types";

/**
 * predict 1 配送で runner_stats に使う get_stats の上限。
 * 父 1、母の父 1、それぞれの再指定 1、騎手 18、騎手の再指定を 2 人分。
 * これを超える再指定は、取れた分だけ渡して欠けを残す。
 *
 * コース要約・通算・ペース・Gemini と足しても、Worker から Durable Object への
 * 呼び出しを外部 50 に数える仮定で 50 未満。Notion 段の 45 は別の配送なので入れない。
 * BASHIRA は Durable Object 経由で、Worker の外部 fetch 予算 45 には数えない。
 */
export const RUNNER_STATS_CALL_LIMIT = 24;

/** 名前フィルタの配列上限。1 レースの父・母父はここまで届かない。 */
export const RUNNER_STATS_NAME_LIMIT = 100;

export const EXPECTED_RUNNER_SCOPE = "jra_and_non_jra";

export const RUNNER_STATS_HEADING = "# 出走馬のコース成績";

export const RUNNER_STATS_EMPTY_LINE = "出走する馬はいません。";

export const RUNNER_STATS_RATE_LINE = "率は出走数と勝ち数・3着以内の件数から計算した。";

export const RUNNER_STATS_LOW_SAMPLE = "件数が少ないため参考値";

export function runnerStatsFailureLine(message: string): string {
  return `取得できませんでした（${message}）。`;
}

const REQUIRED_FIELDS = [
  "race_track",
  "surface",
  "distance",
  "race_meeting_date",
  "sire_name",
  "broodmare_sire_name",
  "jockey_name",
  "official_result",
  "dimensions",
  "metrics",
  "filters",
];

const SURFACES = new Set(["芝", "ダート", "障害"]);
const SCRATCHED = new Set(["出走取消", "発走除外", "競走除外"]);
const YEAR_SUFFIX = /[(（]\s*\d{4}\s*[)）]\s*$/;

const COUNT_METRICS = [
  { agg: "count", where: { official_result: 1 }, as: "wins" },
  { agg: "count", where: { official_result: { lte: 3 } }, as: "top3" },
];

export interface RunnerHorse {
  horseNumber: number | null;
  horseName: string;
  sire: string | null;
  broodmareSire: string | null;
  jockey: string | null;
}

export interface NameStat {
  kind: "ok" | "not_found" | "ambiguous" | "unavailable";
  resolvedName: string | null;
  starts: number | null;
  wins: number | null;
  top3: number | null;
  reason: string | null;
  /** 同じ data_version で取り直しても結果が変わらないときだけ KV に書く。 */
  cacheable: boolean;
}

export interface RunnerStatsResult {
  text: string;
  gaps: string[];
  calls: number;
  cacheHits: number;
  scope: string | null;
  dataVersion: string | null;
}

interface CourseWindow {
  venue: string;
  surface: string;
  distance: number;
  period: { from: string; to: string };
}

interface Budget {
  used: number;
  limit: number;
}

interface ResponseMeta {
  scopes: string[];
  dataVersion: string | null;
  dataThrough: string | null;
}

interface JockeyCacheEntry {
  dataVersion: string;
  scope: string | null;
  dataThrough: string | null;
  periodFrom: string;
  periodTo: string;
  query: string;
  resolvedName: string | null;
  kind: NameStat["kind"];
  starts: number | null;
  wins: number | null;
  top3: number | null;
  reason: string | null;
}

export function runnerHorses(entries: Record<string, unknown>[]): RunnerHorse[] {
  const horses: RunnerHorse[] = [];
  for (const row of entries) {
    if (SCRATCHED.has(stringField(row, "race_abnormality") ?? "")) continue;
    const horseName = stringField(row, "horse_name");
    if (!horseName) continue;
    horses.push({
      horseNumber: numberField(row, "horse_number"),
      horseName,
      sire: stringField(row, "sire_name"),
      broodmareSire: stringField(row, "broodmare_sire_name"),
      jockey: stringField(row, "jockey_name"),
    });
  }
  horses.sort((a, b) => (a.horseNumber ?? 999) - (b.horseNumber ?? 999) || a.horseName.localeCompare(b.horseName, "ja"));
  return horses;
}

/** コース（場・馬場・距離・期間）× 騎手 × data_version。期間はレース日が違うと 1 日ずれる。 */
export function jockeyCourseCacheKey(input: CourseWindow & { dataVersion: string; jockey: string }): string {
  return [
    "jockey-course:v1",
    encodeURIComponent(input.dataVersion),
    encodeURIComponent(input.venue),
    encodeURIComponent(input.surface),
    String(input.distance),
    input.period.from,
    input.period.to,
    encodeURIComponent(input.jockey),
  ].join(":");
}

export function pedigreeStatsArgs(course: CourseWindow, field: "sire_name" | "broodmare_sire_name", names: string[]): Record<string, unknown> {
  return {
    dimensions: [field],
    metrics: COUNT_METRICS,
    filters: { ...courseFilters(course), [field]: names },
  };
}

export function jockeyStatsArgs(course: CourseWindow, jockey: string): Record<string, unknown> {
  return {
    metrics: COUNT_METRICS,
    filters: { ...courseFilters(course), jockey_name: jockey },
  };
}

/**
 * 問い合わせた名前そのものに生年を足した候補がちょうど 1 件のときだけ、その名前を返す。
 * 候補が複数の同名、または別の馬への部分一致のときは決め打ちしない。
 */
export function qualifiedRequeryName(query: string, candidates: Array<{ name: string }>): string | null {
  const matches = candidates.filter((candidate) => {
    if (yearInQualifiedName(candidate.name) == null) return false;
    return candidate.name.replace(YEAR_SUFFIX, "").trim() === query.trim();
  });
  if (matches.length !== 1) return null;
  return matches[0]!.name;
}

export function renderRunnerStats(input: {
  horses: RunnerHorse[];
  venue: string;
  surface: string;
  distance: number;
  period: { from: string; to: string };
  periodYears: number;
  dataThrough: string | null;
  scopes: string[];
  called: boolean;
  sires: Map<string, NameStat>;
  broodmareSires: Map<string, NameStat>;
  jockeys: Map<string, NameStat>;
  minCount: number;
  failure?: string | null;
}): { text: string; gaps: string[] } {
  if (input.failure) {
    return {
      text: `${RUNNER_STATS_HEADING}\n${runnerStatsFailureLine(input.failure)}`,
      gaps: [`出走馬のコース成績（${input.failure}）`],
    };
  }
  if (input.horses.length === 0) {
    return { text: `${RUNNER_STATS_HEADING}\n${RUNNER_STATS_EMPTY_LINE}`, gaps: [] };
  }
  const gaps: string[] = [];
  const scope = input.scopes[0] ?? null;
  const unexpected = [...new Set(input.scopes.filter((item) => item !== EXPECTED_RUNNER_SCOPE))];
  if (input.called && input.scopes.length === 0) {
    gaps.push("出走馬のコース成績（get_stats の scope がありません）");
  } else if (unexpected.length > 0) {
    gaps.push(`出走馬のコース成績（get_stats の scope が ${EXPECTED_RUNNER_SCOPE} ではありません: ${unexpected.join(", ")}）`);
  }
  const lines = [
    RUNNER_STATS_HEADING,
    `条件: ${input.venue} ${input.surface} ${input.distance}m`,
    `期間: ${input.period.from}〜${input.period.to}（レース日の前日までの過去${input.periodYears}年）`,
  ];
  if (input.dataThrough) lines.push(`確定済みデータは ${input.dataThrough} まで。`);
  lines.push(scopeLine(scope));
  lines.push(RUNNER_STATS_RATE_LINE);
  lines.push("");
  for (const horse of input.horses) {
    lines.push(horseHeading(horse));
    lines.push(statLine(horse, "父", horse.sire, input.sires, input.minCount, gaps));
    lines.push(statLine(horse, "母父", horse.broodmareSire, input.broodmareSires, input.minCount, gaps));
    lines.push(statLine(horse, "騎手", horse.jockey, input.jockeys, input.minCount, gaps));
    lines.push("");
  }
  return { text: lines.join("\n").trimEnd(), gaps };
}

export async function collectRunnerStats(input: {
  bashira: BashiraPort;
  catalog: ToolCatalog;
  kv: KvStore;
  entries: Record<string, unknown>[];
  venue: string;
  surface: string;
  distance: number;
  raceDate: string;
  periodYears: number;
  minCount: number;
  now: string;
  callLimit?: number;
}): Promise<RunnerStatsResult> {
  const horses = runnerHorses(input.entries);
  let period: { from: string; to: string };
  try {
    period = courseSummaryPeriod(input.raceDate, input.periodYears);
  } catch (err) {
    return failed(horses, input, err);
  }
  const view = {
    horses,
    venue: input.venue,
    surface: input.surface,
    distance: input.distance,
    period,
    periodYears: input.periodYears,
  };
  if (!SURFACES.has(input.surface)) {
    return finish(view, input.minCount, emptyMaps(), meta(), 0, 0, `馬場種類「${input.surface}」は 芝・ダート・障害 のどれでもありません`);
  }
  if (!Number.isInteger(input.minCount) || input.minCount <= 0) {
    return finish(view, input.minCount, emptyMaps(), meta(), 0, 0, "件数の下限が正の整数ではありません");
  }
  if (horses.length === 0) {
    return finish(view, input.minCount, emptyMaps(), meta(), 0, 0, null);
  }
  try {
    assertRunnerStatsShape(input.catalog, { ...view });
  } catch (err) {
    return failed(horses, { ...input, ...view }, err);
  }
  const budget: Budget = { used: 0, limit: input.callLimit ?? RUNNER_STATS_CALL_LIMIT };
  const course: CourseWindow = view;
  const collected = meta();
  try {
    const pedigree = await fetchPedigree(input.bashira, input.catalog, course, horses, budget, collected);
    const jockeys = await fetchJockeys({
      bashira: input.bashira,
      catalog: input.catalog,
      kv: input.kv,
      course,
      names: uniqueNames(horses.map((horse) => horse.jockey)),
      budget,
      meta: collected,
      fetchedAt: input.now,
    });
    return finish(
      view,
      input.minCount,
      { sires: pedigree.sires, broodmareSires: pedigree.broodmareSires, jockeys: jockeys.stats },
      collected,
      budget.used,
      jockeys.cacheHits,
      null,
    );
  } catch (err) {
    return failed(horses, { ...input, ...view }, err);
  }
}

function failed(
  horses: RunnerHorse[],
  input: { venue: string; surface: string; distance: number; periodYears: number; minCount: number; raceDate?: string },
  err: unknown,
): RunnerStatsResult {
  const message = err instanceof Error ? err.message : String(err);
  let period = { from: "", to: "" };
  try {
    if (input.raceDate) period = courseSummaryPeriod(input.raceDate, input.periodYears);
  } catch {
    period = { from: "", to: "" };
  }
  const rendered = renderRunnerStats({
    horses,
    venue: input.venue,
    surface: input.surface,
    distance: input.distance,
    period,
    periodYears: input.periodYears,
    dataThrough: null,
    scopes: [],
    called: false,
    sires: new Map(),
    broodmareSires: new Map(),
    jockeys: new Map(),
    minCount: input.minCount > 0 ? input.minCount : 30,
    failure: message,
  });
  return { ...rendered, calls: 0, cacheHits: 0, scope: null, dataVersion: null };
}

function finish(
  view: {
    horses: RunnerHorse[];
    venue: string;
    surface: string;
    distance: number;
    period: { from: string; to: string };
    periodYears: number;
  },
  minCount: number,
  maps: { sires: Map<string, NameStat>; broodmareSires: Map<string, NameStat>; jockeys: Map<string, NameStat> },
  collected: ResponseMeta,
  calls: number,
  cacheHits: number,
  failure: string | null,
): RunnerStatsResult {
  const rendered = renderRunnerStats({
    ...view,
    ...maps,
    minCount,
    dataThrough: collected.dataThrough,
    scopes: collected.scopes,
    called: calls > 0 || cacheHits > 0,
    failure,
  });
  return {
    ...rendered,
    calls,
    cacheHits,
    scope: collected.scopes[0] ?? null,
    dataVersion: collected.dataVersion,
  };
}

function assertRunnerStatsShape(catalog: ToolCatalog, course: CourseWindow): void {
  assertFields(catalog, "get_stats", REQUIRED_FIELDS);
  assertToolArgs(catalog, "get_stats", pedigreeStatsArgs(course, "sire_name", ["名"]));
  assertToolArgs(catalog, "get_stats", pedigreeStatsArgs(course, "broodmare_sire_name", ["名"]));
  assertToolArgs(catalog, "get_stats", jockeyStatsArgs(course, "名"));
  const blob = JSON.stringify([
    pedigreeStatsArgs(course, "sire_name", ["名"]),
    pedigreeStatsArgs(course, "broodmare_sire_name", ["名"]),
    jockeyStatsArgs(course, "名"),
  ]);
  if (blob.includes("min_starts") || blob.includes("win_payout") || blob.includes("win_odds_rank")) {
    throw new Error("出走馬のコース成績に min_starts、払戻、人気は入れません");
  }
}

async function fetchPedigree(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  course: CourseWindow,
  horses: RunnerHorse[],
  budget: Budget,
  collected: ResponseMeta,
): Promise<{ sires: Map<string, NameStat>; broodmareSires: Map<string, NameStat> }> {
  const fields = [
    { field: "sire_name" as const, names: uniqueNames(horses.map((horse) => horse.sire)) },
    { field: "broodmare_sire_name" as const, names: uniqueNames(horses.map((horse) => horse.broodmareSire)) },
  ];
  const sires = new Map<string, NameStat>();
  const broodmareSires = new Map<string, NameStat>();
  const target = (field: "sire_name" | "broodmare_sire_name") => (field === "sire_name" ? sires : broodmareSires);
  const initial: Array<{ id: string; field: "sire_name" | "broodmare_sire_name"; names: string[]; args: Record<string, unknown> }> = [];
  for (const slot of fields) {
    const parts = chunks(slot.names, RUNNER_STATS_NAME_LIMIT);
    parts.forEach((names, index) => {
      initial.push({
        id: `${slot.field}:${index}`,
        field: slot.field,
        names,
        args: pedigreeStatsArgs(course, slot.field, names),
      });
    });
  }
  const first = await runStatsCalls(bashira, catalog, initial, budget);
  const requery: Array<{
    id: string;
    field: "sire_name" | "broodmare_sire_name";
    names: string[];
    pairs: Array<{ query: string; requested: string }>;
    args: Record<string, unknown>;
  }> = [];
  for (const call of initial) {
    const result = first.get(call.id);
    const map = target(call.field);
    if (!result?.ok) {
      const reason = result && !result.ok ? result.message : "get_stats の応答がありません";
      for (const name of call.names) map.set(name, unavailable(reason, false));
      continue;
    }
    const read = interpretGrouped(result.data, call.field, call.names);
    absorb(collected, result.data);
    if (!read.aborted) {
      for (const [name, stat] of read.stats) map.set(name, stat);
      continue;
    }
    const pairs: Array<{ query: string; requested: string }> = [];
    for (const name of call.names) {
      const requested = read.pending.get(name);
      if (requested) pairs.push({ query: name, requested });
      else map.set(name, read.stats.get(name) ?? unavailable("集計を読めません", false));
    }
    if (pairs.length === 0) continue;
    const names = uniqueNames(pairs.map((pair) => pair.requested));
    requery.push({
      id: `${call.id}:again`,
      field: call.field,
      names,
      pairs,
      args: pedigreeStatsArgs(course, call.field, names),
    });
  }
  const second = await runStatsCalls(bashira, catalog, requery, budget);
  for (const call of requery) {
    const result = second.get(call.id);
    const map = target(call.field);
    if (!result?.ok) {
      const reason = result && !result.ok ? result.message : "生年付きの再指定に失敗しました";
      for (const pair of call.pairs) map.set(pair.query, unavailable(reason, false));
      continue;
    }
    const read = interpretGrouped(result.data, call.field, call.names);
    absorb(collected, result.data);
    for (const pair of call.pairs) {
      if (read.aborted || read.pending.has(pair.requested)) {
        map.set(pair.query, ambiguous("生年付きで指定し直しても特定できない", true));
        continue;
      }
      const stat = read.stats.get(pair.requested);
      map.set(pair.query, stat ?? unavailable("生年付きの再指定の行がありません", false));
    }
  }
  return { sires, broodmareSires };
}

async function fetchJockeys(input: {
  bashira: BashiraPort;
  catalog: ToolCatalog;
  kv: KvStore;
  course: CourseWindow;
  names: string[];
  budget: Budget;
  meta: ResponseMeta;
  fetchedAt: string;
}): Promise<{ stats: Map<string, NameStat>; cacheHits: number }> {
  const stats = new Map<string, NameStat>();
  let cacheHits = 0;
  let left = [...input.names];
  while (left.length > 0) {
    if (input.meta.dataVersion) {
      const hits = await readJockeyCaches(input.kv, input.course, input.meta.dataVersion, left);
      for (const [name, hit] of hits) {
        stats.set(name, hit.stat);
        if (hit.scope) input.meta.scopes.push(hit.scope);
        if (!input.meta.dataThrough && hit.dataThrough) input.meta.dataThrough = hit.dataThrough;
        cacheHits += 1;
      }
      left = left.filter((name) => !stats.has(name));
    }
    if (left.length === 0) break;
    const room = input.budget.limit - input.budget.used;
    if (room <= 0) {
      for (const name of left) stats.set(name, unavailable("呼び出し上限のため取得していない", false));
      break;
    }
    const batch = left.slice(0, Math.min(STATS_BATCH_SIZE, room));
    left = left.slice(batch.length);
    const calls = batch.map((jockey) => ({
      id: `jockey:${encodeURIComponent(jockey)}`,
      jockey,
      args: jockeyStatsArgs(input.course, jockey),
    }));
    const got = await runStatsCalls(input.bashira, input.catalog, calls, input.budget);
    const requery: Array<{ jockey: string; requested: string }> = [];
    for (const call of calls) {
      const result = got.get(call.id);
      if (!result?.ok) {
        stats.set(call.jockey, unavailable(result && !result.ok ? result.message : "get_stats の応答がありません", false));
        continue;
      }
      absorb(input.meta, result.data);
      const read = interpretSingle(result.data, call.jockey);
      if (read.requeryAs) requery.push({ jockey: call.jockey, requested: read.requeryAs });
      else stats.set(call.jockey, read.stat);
    }
    await writeReadyJockeys(input, stats, batch);
    if (requery.length === 0) continue;
    const againCalls = requery.map((item) => ({
      id: `jockey-again:${encodeURIComponent(item.jockey)}`,
      jockey: item.jockey,
      requested: item.requested,
      args: jockeyStatsArgs(input.course, item.requested),
    }));
    const again = await runStatsCalls(input.bashira, input.catalog, againCalls, input.budget);
    for (const call of againCalls) {
      const result = again.get(call.id);
      if (!result) {
        stats.set(call.jockey, unavailable("生年付きで指定し直す呼び出しが残っていない", false));
        continue;
      }
      if (!result.ok) {
        stats.set(call.jockey, unavailable(result.message, false));
        continue;
      }
      absorb(input.meta, result.data);
      const read = interpretSingle(result.data, call.requested);
      if (read.requeryAs || read.stat.kind === "ambiguous") {
        stats.set(call.jockey, ambiguous("生年付きで指定し直しても特定できない", true));
      } else {
        stats.set(call.jockey, read.stat);
      }
    }
    await writeReadyJockeys(input, stats, requery.map((item) => item.jockey));
  }
  return { stats, cacheHits };
}

async function writeReadyJockeys(
  input: { kv: KvStore; course: CourseWindow; meta: ResponseMeta; fetchedAt: string },
  stats: Map<string, NameStat>,
  names: string[],
): Promise<void> {
  const dataVersion = input.meta.dataVersion;
  if (!dataVersion) return;
  const scope = input.meta.scopes[0] ?? null;
  await Promise.all(
    names.map(async (jockey) => {
      const stat = stats.get(jockey);
      if (!stat?.cacheable) return;
      const entry: JockeyCacheEntry = {
        dataVersion,
        scope,
        dataThrough: input.meta.dataThrough,
        periodFrom: input.course.period.from,
        periodTo: input.course.period.to,
        query: jockey,
        resolvedName: stat.resolvedName,
        kind: stat.kind,
        starts: stat.starts,
        wins: stat.wins,
        top3: stat.top3,
        reason: stat.reason,
      };
      try {
        await input.kv.put(jockeyCourseCacheKey({ ...input.course, dataVersion, jockey }), JSON.stringify(entry), {
          expirationTtl: STATS_CACHE_TTL_SECONDS,
        });
      } catch {
        // キャッシュに書けなくても、取れた成績は渡す。次のレースは取り直す。
      }
    }),
  );
}

async function readJockeyCaches(
  kv: KvStore,
  course: CourseWindow,
  dataVersion: string,
  names: string[],
): Promise<Map<string, { stat: NameStat; scope: string | null; dataThrough: string | null }>> {
  const hits = new Map<string, { stat: NameStat; scope: string | null; dataThrough: string | null }>();
  await Promise.all(
    names.map(async (jockey) => {
      const raw = await kv.get(jockeyCourseCacheKey({ ...course, dataVersion, jockey }));
      if (!raw) return;
      const hit = parseJockeyCache(raw, { dataVersion, jockey, period: course.period });
      if (hit) hits.set(jockey, hit);
    }),
  );
  return hits;
}

function parseJockeyCache(
  raw: string,
  expected: { dataVersion: string; jockey: string; period: { from: string; to: string } },
): { stat: NameStat; scope: string | null; dataThrough: string | null } | null {
  let parsed: Partial<JockeyCacheEntry>;
  try {
    parsed = JSON.parse(raw) as Partial<JockeyCacheEntry>;
  } catch {
    return null;
  }
  if (parsed.dataVersion !== expected.dataVersion || parsed.query !== expected.jockey) return null;
  if (parsed.periodFrom !== expected.period.from || parsed.periodTo !== expected.period.to) return null;
  if (parsed.kind !== "ok" && parsed.kind !== "not_found" && parsed.kind !== "ambiguous") return null;
  const stat = statFromCache(parsed);
  if (!stat) return null;
  return {
    stat,
    scope: typeof parsed.scope === "string" ? parsed.scope : null,
    dataThrough: typeof parsed.dataThrough === "string" ? parsed.dataThrough : null,
  };
}

function statFromCache(parsed: Partial<JockeyCacheEntry>): NameStat | null {
  if (parsed.kind === "not_found") return notFound(true);
  if (parsed.kind === "ambiguous") return ambiguous(parsed.reason ?? "同名のため特定できない", true);
  if (parsed.kind !== "ok") return null;
  const starts = parsed.starts;
  const wins = parsed.wins;
  const top3 = parsed.top3;
  if (!isCount(starts) || !isCount(wins) || !isCount(top3)) return null;
  if (wins > starts || top3 > starts) return null;
  return okStat(parsed.resolvedName ?? parsed.query ?? null, starts, wins, top3, true);
}

interface StatsRequest {
  id: string;
  args: Record<string, unknown>;
}

async function runStatsCalls(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  calls: StatsRequest[],
  budget: Budget,
): Promise<Map<string, { ok: true; data: unknown } | { ok: false; message: string }>> {
  const out = new Map<string, { ok: true; data: unknown } | { ok: false; message: string }>();
  let index = 0;
  while (index < calls.length) {
    const room = budget.limit - budget.used;
    if (room <= 0) {
      for (const call of calls.slice(index)) out.set(call.id, { ok: false, message: "呼び出し上限のため取得していない" });
      break;
    }
    const batch = calls.slice(index, index + Math.min(STATS_BATCH_SIZE, room));
    index += batch.length;
    for (const call of batch) assertToolArgs(catalog, "get_stats", call.args);
    budget.used += batch.length;
    const result = await bashira.callTools(batch.map((call) => ({ name: "get_stats", args: call.args })));
    const results = result.results ?? [];
    for (let offset = 0; offset < batch.length; offset += 1) {
      const call = batch[offset]!;
      if (offset >= results.length) {
        out.set(call.id, { ok: false, message: result.ok ? "get_stats の応答がありません" : result.message });
        continue;
      }
      out.set(call.id, { ok: true, data: results[offset] });
    }
  }
  return out;
}

interface GroupRead {
  aborted: boolean;
  stats: Map<string, NameStat>;
  /** 元の問い合わせ名 → 再指定に出す名前。 */
  pending: Map<string, string>;
}

function interpretGrouped(payload: unknown, field: string, queries: string[]): GroupRead {
  const info = responseInfo(payload);
  const resolutions = indexResolutions(readNameResolutions(payload), field);
  const rows = indexRows(payload, field);
  const stats = new Map<string, NameStat>();
  const pending = new Map<string, string>();
  for (const query of queries) {
    const resolution = resolutions.get(query) ?? null;
    if (resolution?.unresolved) {
      const qualified = qualifiedRequeryName(query, resolution.candidates);
      if (qualified) pending.set(query, qualified);
      else stats.set(query, ambiguous("同名のため特定できない", true));
      continue;
    }
    if (resolution?.status === "not_found") {
      stats.set(query, notFound(true));
      continue;
    }
    if (info.aborted) {
      const requested = resolution ? (resolution.candidates[0]?.name ?? query) : query;
      pending.set(query, requested);
      continue;
    }
    const resolvedName = resolution?.candidates[0]?.name ?? query;
    const row = rows.get(resolvedName) ?? rows.get(query) ?? null;
    if (row === "dup") {
      stats.set(query, unavailable("同じ名前の行が複数あります", false));
      continue;
    }
    if (!row) {
      if (!resolution || info.truncated) stats.set(query, unavailable(info.truncated ? "集計が打ち切られました" : "名前の解決結果がありません", false));
      else stats.set(query, okStat(resolvedName, 0, 0, 0, true));
      continue;
    }
    stats.set(query, countsFromRow(row, resolvedName));
  }
  return { aborted: info.aborted, stats, pending };
}

function interpretSingle(payload: unknown, query: string): { stat: NameStat; requeryAs: string | null } {
  const info = responseInfo(payload);
  const resolution = indexResolutions(readNameResolutions(payload), "jockey_name").get(query) ?? null;
  if (resolution?.unresolved || (info.aborted && resolution?.status !== "resolved" && resolution?.status !== "not_found")) {
    const qualified = resolution ? qualifiedRequeryName(query, resolution.candidates) : null;
    if (qualified) return { stat: ambiguous("同名のため特定できない", false), requeryAs: qualified };
    return { stat: ambiguous("同名のため特定できない", true), requeryAs: null };
  }
  if (resolution?.status === "not_found") return { stat: notFound(true), requeryAs: null };
  if (info.aborted) {
    const requested = resolution?.candidates[0]?.name ?? query;
    if (requested !== query) return { stat: ambiguous("同名のため特定できない", false), requeryAs: requested };
    return { stat: unavailable("名前が確定していないため行を使いません", false), requeryAs: null };
  }
  const rows = rowsToObjects(payload);
  if (info.truncated && rows.length === 0) return { stat: unavailable("集計が打ち切られました", false), requeryAs: null };
  if (rows.length > 1) return { stat: unavailable("騎手の集計が複数行あります", false), requeryAs: null };
  if (rows.length === 0) {
    if (!resolution) return { stat: unavailable("名前の解決結果がありません", false), requeryAs: null };
    return { stat: okStat(resolution.candidates[0]?.name ?? query, 0, 0, 0, true), requeryAs: null };
  }
  return { stat: countsFromRow(rows[0]!, resolution?.candidates[0]?.name ?? query), requeryAs: null };
}

function countsFromRow(row: Record<string, unknown>, resolvedName: string | null): NameStat {
  const starts = countOrNull(row, "starts");
  const wins = countOrNull(row, "wins");
  const top3 = countOrNull(row, "top3");
  if (starts == null || wins == null || top3 == null) {
    return unavailable("件数を読めません", false);
  }
  if (wins > starts || top3 > starts) return unavailable("件数が食い違っています", false);
  return okStat(resolvedName, starts, wins, top3, true);
}

function responseInfo(payload: unknown): { aborted: boolean; truncated: boolean } {
  const note = payloadNote(payload);
  const unresolved = readNameResolutions(payload).some((entry) => entry.unresolved);
  const truncated = Boolean(payload && typeof payload === "object" && (payload as { truncated?: unknown }).truncated === true);
  return { aborted: unresolved || note.includes("絞り込みを実行していません"), truncated };
}

function absorb(meta: ResponseMeta, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const record = payload as { scope?: unknown; data_version?: unknown; data_through?: unknown };
  if (typeof record.scope === "string" && record.scope.trim() !== "") meta.scopes.push(record.scope);
  if (!meta.dataVersion && typeof record.data_version === "string" && record.data_version.trim() !== "") {
    meta.dataVersion = record.data_version.trim();
  }
  if (!meta.dataThrough && typeof record.data_through === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.data_through)) {
    meta.dataThrough = record.data_through;
  }
}

function indexResolutions(entries: NameResolutionEntry[], field: string): Map<string, NameResolutionEntry> {
  const map = new Map<string, NameResolutionEntry>();
  for (const entry of entries) {
    if (entry.field && entry.field !== field) continue;
    if (!entry.query) continue;
    map.set(entry.query, entry);
  }
  return map;
}

function indexRows(payload: unknown, field: string): Map<string, Record<string, unknown> | "dup"> {
  const map = new Map<string, Record<string, unknown> | "dup">();
  for (const row of rowsToObjects(payload)) {
    const name = stringField(row, field);
    if (!name) continue;
    map.set(name, map.has(name) ? "dup" : row);
  }
  return map;
}

function statLine(
  horse: RunnerHorse,
  label: "父" | "母父" | "騎手",
  name: string | null,
  stats: Map<string, NameStat>,
  minCount: number,
  gaps: string[],
): string {
  const who = horseLabel(horse);
  if (!name) {
    gaps.push(`${who} の${label}（出馬表に無い）`);
    return `${label}: 出馬表に無い`;
  }
  const stat = stats.get(name);
  if (!stat || stat.kind === "unavailable") {
    const reason = stat?.reason ?? "取得できず";
    gaps.push(`${who} の${label} ${name}（${reason}）`);
    return `${label} ${name}: 取得できず（${reason}）`;
  }
  if (stat.kind === "not_found") {
    gaps.push(`${who} の${label} ${name}（名前が見つからない）`);
    return `${label} ${name}: 名前が見つからない`;
  }
  if (stat.kind === "ambiguous") {
    const reason = stat.reason ?? "同名のため特定できない";
    gaps.push(`${who} の${label} ${name}（${reason}）`);
    return `${label} ${name}: ${reason}`;
  }
  if (stat.starts == null || stat.wins == null || stat.top3 == null) {
    gaps.push(`${who} の${label} ${name}（件数を読めません）`);
    return `${label} ${name}: 取得できず（件数を読めません）`;
  }
  const shown = stat.resolvedName ?? name;
  const note = stat.starts < minCount ? ` ${RUNNER_STATS_LOW_SAMPLE}` : "";
  return `${label} ${shown}: 出走 ${stat.starts}　勝ち ${stat.wins}　勝率 ${formatRate(stat.wins, stat.starts)}　複勝 ${stat.top3}　複勝率 ${formatRate(stat.top3, stat.starts)}${note}`;
}

function scopeLine(scope: string | null): string {
  if (scope === EXPECTED_RUNNER_SCOPE) {
    return "scope: jra_and_non_jra。条件の競馬場名は中央の開催場で、地方の同名場は別の名前なので、この件数は中央のそのコースの走。";
  }
  if (scope) return `scope: ${scope}`;
  return "scope: なし";
}

function horseHeading(horse: RunnerHorse): string {
  return `### ${horseLabel(horse)}`;
}

function horseLabel(horse: RunnerHorse): string {
  const number = horse.horseNumber == null ? "?" : String(horse.horseNumber);
  return `${number} ${horse.horseName}`;
}

function courseFilters(course: CourseWindow): Record<string, unknown> {
  return {
    race_track: course.venue,
    surface: course.surface,
    distance: course.distance,
    race_meeting_date: { gte: course.period.from, lte: course.period.to },
  };
}

function uniqueNames(values: Array<string | null>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    names.push(value);
  }
  return names;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function meta(): ResponseMeta {
  return { scopes: [], dataVersion: null, dataThrough: null };
}

function emptyMaps(): { sires: Map<string, NameStat>; broodmareSires: Map<string, NameStat>; jockeys: Map<string, NameStat> } {
  return { sires: new Map(), broodmareSires: new Map(), jockeys: new Map() };
}

function okStat(resolvedName: string | null, starts: number, wins: number, top3: number, cacheable: boolean): NameStat {
  return { kind: "ok", resolvedName, starts, wins, top3, reason: null, cacheable };
}

function notFound(cacheable: boolean): NameStat {
  return { kind: "not_found", resolvedName: null, starts: null, wins: null, top3: null, reason: "名前が見つからない", cacheable };
}

function ambiguous(reason: string, cacheable: boolean): NameStat {
  return { kind: "ambiguous", resolvedName: null, starts: null, wins: null, top3: null, reason, cacheable };
}

function unavailable(reason: string, cacheable: boolean): NameStat {
  return { kind: "unavailable", resolvedName: null, starts: null, wins: null, top3: null, reason, cacheable };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function countOrNull(row: Record<string, unknown>, key: string): number | null {
  if (!(key in row) || row[key] == null || row[key] === "") return null;
  const value = numberField(row, key);
  if (!isCount(value)) return null;
  return value;
}
