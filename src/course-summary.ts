import { ambiguousNameMessage } from "./bashira/mcp";
import type { BashiraPort } from "./bashira/port";
import { courseSideScopeLine, withCourseSideFilter, type CourseSideState } from "./course-side";
import { numberField, rowsToObjects, stringField } from "./rows";
import { assertFields, assertToolArgs, type ToolCatalog } from "./schema";
import { JobError, STATS_BATCH_SIZE } from "./types";

/**
 * レース数、または区分の件数がこれ未満のとき「開催が少ないため参考値」と書く。
 * 実行時の値は wrangler の `COURSE_SUMMARY_MIN_COUNT`。
 */
export const DEFAULT_COURSE_SUMMARY_MIN_COUNT = 30;

/** get_races の 1 呼び出しの上限。BASHIRA の limit 最大は 200。打ち切れたときは offset で続ける。 */
export const COURSE_RACE_COUNT_LIMIT = 200;
/** get_races の offset 上限（スキーマの maximum）。 */
const COURSE_RACE_OFFSET_MAX = 2000;

/** 集計に失敗したとき、コース分析の差し込みに入れる文。 */
export const COURSE_SUMMARY_UNAVAILABLE = "コースデータ要約はありません（集計に失敗しました）。";

const SUMMARY_FIELDS = [
  "race_track",
  "surface",
  "distance",
  "race_meeting_date",
  "fourth_corner_position",
  "is_fastest_last_3f",
  "bracket_number",
  "track_condition",
  "official_result",
  "dimensions",
  "metrics",
  "filters",
];

const RACE_COUNT_FIELDS = ["race_meeting_date", "race_track", "surface", "distance", "race_status", "race_id", "filters", "columns", "limit"];

const SURFACES = new Set(["芝", "ダート", "障害"]);

const WINS_AND_TOP3 = [
  { agg: "count", where: { official_result: 1 }, as: "wins" },
  { agg: "count", where: { official_result: { lte: 3 } }, as: "top3" },
];

/** 4角の位置。先頭は 1、それ以外は閉区間。get_stats は位置を軸にできないので、区分ごとに絞る。 */
export const CORNER_BUCKETS = [
  { id: "lead", label: "先頭", filter: 1 },
  { id: "2-4", label: "2〜4番手", filter: { gte: 2, lte: 4 } },
  { id: "5-9", label: "5〜9番手", filter: { gte: 5, lte: 9 } },
  { id: "10plus", label: "10番手以下", filter: { gte: 10 } },
] as const;

const GOOD_GOING = new Set(["良", "稍重"]);
const HEAVY_GOING = new Set(["重", "不良"]);

const SAMPLE_NOTE = "開催が少ないため参考値";

export interface CourseSummaryRecord {
  status: "ok" | "failed";
  text: string | null;
  error: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  raceCount: number | null;
  raceCountTruncated: boolean;
}

export interface CourseSummaryQuery {
  id: string;
  args: Record<string, unknown>;
}

export interface CourseSummaryPlan {
  period: { from: string; to: string };
  stats: CourseSummaryQuery[];
  races: Record<string, unknown>;
}

export function failedCourseSummary(error: string, period?: { from: string; to: string } | null): CourseSummaryRecord {
  return {
    status: "failed",
    text: null,
    error,
    periodFrom: period?.from ?? null,
    periodTo: period?.to ?? null,
    raceCount: null,
    raceCountTruncated: false,
  };
}

export function courseSummaryText(record: CourseSummaryRecord | null | undefined): string {
  if (record?.status === "ok" && record.text) return record.text;
  return COURSE_SUMMARY_UNAVAILABLE;
}

/** レース日の前日を終点に、そこから過去 `years` 年。2026-11-08 の 5 年は 2021-11-07〜2026-11-07。 */
export function courseSummaryPeriod(raceDate: string, years: number): { from: string; to: string } {
  if (!Number.isInteger(years) || years <= 0) {
    throw new JobError("コースデータ要約の年数が正の整数ではありません", false);
  }
  const to = addCalendarDays(raceDate, -1);
  const from = addCalendarYears(to, -years);
  return { from, to };
}

export function buildCourseSummaryPlan(input: {
  catalog: ToolCatalog;
  venue: string;
  surface: string;
  distance: number;
  raceDate: string;
  periodYears: number;
  /** 省略時は回りで絞らない。 */
  courseSide?: CourseSideState | null;
}): CourseSummaryPlan {
  assertFields(input.catalog, "get_stats", SUMMARY_FIELDS);
  assertFields(input.catalog, "get_races", RACE_COUNT_FIELDS);
  if (!SURFACES.has(input.surface)) {
    throw new JobError(`馬場種類「${input.surface}」は 芝・ダート・障害 のどれでもありません`, false);
  }
  if (input.courseSide?.statsFilter) assertFields(input.catalog, "get_stats", ["course_side"]);
  if (input.courseSide?.racesFilter) assertFields(input.catalog, "get_races", ["course_side"]);
  const period = courseSummaryPeriod(input.raceDate, input.periodYears);
  const window = {
    race_track: input.venue,
    surface: input.surface,
    distance: input.distance,
    race_meeting_date: { gte: period.from, lte: period.to },
  };
  const base = withCourseSideFilter(window, input.courseSide?.statsFilter);
  const stats: CourseSummaryQuery[] = [
    { id: "totals", args: { metrics: WINS_AND_TOP3, filters: base } },
    ...CORNER_BUCKETS.map((bucket) => ({
      id: `corner:${bucket.id}`,
      args: {
        metrics: WINS_AND_TOP3,
        filters: { ...base, fourth_corner_position: bucket.filter },
      },
    })),
    {
      id: "fastest",
      args: {
        metrics: [{ agg: "count", where: { official_result: 1 }, as: "wins" }],
        filters: { ...base, is_fastest_last_3f: true },
      },
    },
    {
      id: "bracket",
      args: { dimensions: ["bracket_number"], metrics: WINS_AND_TOP3, filters: base },
    },
    {
      id: "going",
      args: {
        dimensions: ["track_condition"],
        metrics: [
          { agg: "count", where: { official_result: 1 }, as: "wins" },
          { agg: "count", where: { official_result: 1, fourth_corner_position: { lte: 4 } }, as: "front_wins" },
        ],
        filters: base,
      },
    },
  ];
  if (stats.length > STATS_BATCH_SIZE) {
    throw new JobError("コースデータ要約の get_stats が 1 回の呼び出し上限を超えています", false);
  }
  for (const stat of stats) assertToolArgs(input.catalog, "get_stats", stat.args);
  const races = {
    filters: withCourseSideFilter({ ...window, race_status: "finished" }, input.courseSide?.racesFilter),
    columns: ["race_id", "race_status"],
    limit: COURSE_RACE_COUNT_LIMIT,
  };
  assertToolArgs(input.catalog, "get_races", races);
  assertSummaryScope(stats, races);
  return { period, stats, races };
}

export async function collectCourseSummary(input: {
  bashira: BashiraPort;
  catalog: ToolCatalog;
  venue: string;
  surface: string;
  distance: number;
  raceDate: string;
  periodYears: number;
  minCount: number;
  courseSide?: CourseSideState | null;
}): Promise<CourseSummaryRecord> {
  const plan = buildCourseSummaryPlan(input);
  const statsCall = await input.bashira.callTools(plan.stats.map((stat) => ({ name: "get_stats", args: stat.args })));
  if (!statsCall.ok) throw new JobError(statsCall.message, false);
  const results = statsCall.results ?? [];
  if (results.length !== plan.stats.length) {
    throw new JobError("get_stats の応答件数が足りないため、コースデータ要約を作れません", false);
  }
  const payloads: Record<string, unknown> = {};
  for (let index = 0; index < plan.stats.length; index += 1) {
    const payload = results[index];
    const ambiguity = ambiguousNameMessage(payload);
    if (ambiguity) throw new JobError(ambiguity, false);
    payloads[plan.stats[index]!.id] = payload;
  }
  const racesPayload = await loadRaceCountPayload(input.bashira, input.catalog, plan.races);
  const rendered = renderCourseSummary({
    venue: input.venue,
    surface: input.surface,
    distance: input.distance,
    period: plan.period,
    periodYears: input.periodYears,
    payloads,
    racesPayload,
    minCount: input.minCount,
    courseSide: input.courseSide,
  });
  return {
    status: "ok",
    text: rendered.text,
    error: null,
    periodFrom: plan.period.from,
    periodTo: plan.period.to,
    raceCount: rendered.raceCount,
    raceCountTruncated: rendered.raceCountTruncated,
  };
}

/**
 * 確定済みレースの一覧。truncated かつ offset があるときは、row_count を足して続きを取る。
 * 1 ページで足りるときは応答をそのまま返す。取り切れないときは truncated のまま数の下限にする。
 */
async function loadRaceCountPayload(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  args: Record<string, unknown>,
): Promise<unknown> {
  const canOffset = catalog.tools.get_races?.argNames.includes("offset") === true;
  const pages: unknown[] = [];
  let offset = 0;
  let version: string | null = null;
  let restarts = 0;
  for (;;) {
    const callArgs: Record<string, unknown> = { ...args };
    if (canOffset && offset > 0) callArgs.offset = offset;
    assertToolArgs(catalog, "get_races", callArgs);
    const result = await bashira.callTool("get_races", callArgs);
    if (!result.ok) throw new JobError(result.message, false);
    const ambiguity = ambiguousNameMessage(result.data);
    if (ambiguity) throw new JobError(ambiguity, false);
    const nextVersion = dataVersionOf(result.data);
    if (offset > 0 && version !== nextVersion) {
      if (restarts >= 1) return mergeRacePages(pages, true);
      restarts += 1;
      pages.length = 0;
      offset = 0;
      version = null;
      continue;
    }
    version = nextVersion;
    const truncated = isTruncated(result.data);
    if (!truncated && pages.length === 0 && restarts === 0) return result.data;
    pages.push(result.data);
    if (!truncated) return mergeRacePages(pages, false);
    if (!canOffset) return result.data;
    const count = pageRowCount(result.data);
    if (count <= 0 || offset + count > COURSE_RACE_OFFSET_MAX) return mergeRacePages(pages, true);
    offset += count;
  }
}

function mergeRacePages(pages: unknown[], truncated: boolean): unknown {
  const rows: unknown[] = [];
  let columns: unknown = ["race_id", "race_status"];
  for (const page of pages) {
    if (page && typeof page === "object" && Array.isArray((page as { columns?: unknown }).columns)) {
      columns = (page as { columns: unknown }).columns;
    }
    const raw = page && typeof page === "object" ? (page as { rows?: unknown }).rows : null;
    if (Array.isArray(raw)) rows.push(...raw);
  }
  return { columns, rows, row_count: rows.length, truncated };
}

function dataVersionOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { data_version?: unknown }).data_version;
  return typeof value === "string" && value !== "" ? value : null;
}

function pageRowCount(payload: unknown): number {
  const reported = payload && typeof payload === "object" ? numberField(payload as Record<string, unknown>, "row_count") : null;
  if (reported != null && reported >= 0) return reported;
  return rowsToObjects(payload).length;
}

function isTruncated(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { truncated?: unknown }).truncated === true);
}

export function renderCourseSummary(input: {
  venue: string;
  surface: string;
  distance: number;
  period: { from: string; to: string };
  periodYears: number;
  payloads: Record<string, unknown>;
  racesPayload: unknown;
  minCount: number;
  courseSide?: CourseSideState | null;
}): { text: string; raceCount: number; raceCountTruncated: boolean } {
  if (!Number.isInteger(input.minCount) || input.minCount <= 0) {
    throw new JobError("コースデータ要約の件数の下限が正の整数ではありません", false);
  }
  const totals = readSingle(input.payloads.totals, "全体", ["starts", "wins", "top3"]);
  const corners = CORNER_BUCKETS.map((bucket) => {
    const row = readSingle(input.payloads[`corner:${bucket.id}`], bucket.label, ["wins", "top3"]);
    return { label: bucket.label, wins: row.wins, top3: row.top3 };
  });
  const knownWins = corners.reduce((sum, bucket) => sum + bucket.wins, 0);
  const knownTop3 = corners.reduce((sum, bucket) => sum + bucket.top3, 0);
  if (knownWins > totals.wins || knownTop3 > totals.top3) {
    throw new JobError("4角の件数が全体の件数を超えているため、コースデータ要約を作れません", false);
  }
  const fastest = readSingle(input.payloads.fastest, "上がり3F最速", ["starts", "wins"]);
  const brackets = readGrouped(input.payloads.bracket, "枠番", "bracket_number", ["starts", "wins", "top3"]);
  const going = readGrouped(input.payloads.going, "馬場状態", "track_condition", ["wins", "front_wins"]);
  for (const row of going) {
    if (row.front_wins > row.wins) {
      throw new JobError("前残りの件数が勝ち数を超えているため、コースデータ要約を作れません", false);
    }
  }
  const races = readRaceCount(input.racesPayload);
  const inside = sumBrackets(brackets, 1, 4);
  const outside = sumBrackets(brackets, 5, 8);
  const outsideRange = brackets.filter((row) => {
    const bracket = numericKey(row.key);
    return bracket == null || bracket < 1 || bracket > 8;
  });
  const firm = sumGoing(going, GOOD_GOING);
  const heavy = sumGoing(going, HEAVY_GOING);
  const otherGoing = going.filter((row) => !GOOD_GOING.has(row.key) && !HEAVY_GOING.has(row.key) && row.wins > 0);
  const dataThrough = readDataThrough(input.payloads.totals);
  const raceNote = !races.truncated && races.count < input.minCount ? ` ${SAMPLE_NOTE}` : "";
  const lines = [
    "コースデータ要約",
    `条件: ${input.venue} ${input.surface} ${input.distance}m`,
    ...courseSideLines(input.courseSide),
    `期間: ${input.period.from}〜${input.period.to}（レース日の前日までの過去${input.periodYears}年）`,
    `レース数: ${raceCountLabel(races)}${raceNote}`,
    `出走数: ${totals.starts}　勝ち数: ${totals.wins}`,
  ];
  if (dataThrough) lines.push(`確定済みデータは ${dataThrough} まで。`);
  lines.push("率は件数から計算した。回収率は含まない。4角の位置・上がり3F・枠番は JRA の走だけを数える。");
  lines.push("");
  lines.push("脚質（4角の位置）");
  lines.push(`勝ち馬 ${totals.wins}頭に占める割合`);
  for (const bucket of corners) {
    lines.push(shareLine(bucket.label, bucket.wins, totals.wins, input.minCount));
  }
  const unknownWins = totals.wins - knownWins;
  if (unknownWins > 0) lines.push(shareLine("4角順位なし", unknownWins, totals.wins, input.minCount));
  lines.push(`3着以内 ${totals.top3}頭に占める割合`);
  for (const bucket of corners) {
    lines.push(shareLine(bucket.label, bucket.top3, totals.top3, input.minCount));
  }
  const unknownTop3 = totals.top3 - knownTop3;
  if (unknownTop3 > 0) lines.push(shareLine("4角順位なし", unknownTop3, totals.top3, input.minCount));
  lines.push(
    `上がり3F最速: 出走 ${fastest.starts}　勝ち ${fastest.wins}　勝率 ${formatRate(fastest.wins, fastest.starts)}${noteSuffix(fastest.starts, input.minCount)}`,
  );
  lines.push("");
  lines.push("内外");
  lines.push(bracketLine("1〜4枠", inside, input.minCount));
  lines.push(bracketLine("5〜8枠", outside, input.minCount));
  const otherStarts = outsideRange.reduce((sum, row) => sum + row.starts, 0);
  if (otherStarts > 0) {
    const otherWins = outsideRange.reduce((sum, row) => sum + row.wins, 0);
    lines.push(`- 1〜8枠以外: 出走 ${otherStarts}　勝ち ${otherWins}${noteSuffix(otherStarts, input.minCount)}`);
  }
  lines.push("");
  lines.push("馬場状態別の前残り（勝ち馬のうち4角4番手以内）");
  lines.push(goingLine("良・稍重", firm, input.minCount));
  lines.push(goingLine("重・不良", heavy, input.minCount));
  for (const row of otherGoing) {
    lines.push(`- その他（${row.key}）: 勝ち ${row.wins}頭${noteSuffix(row.wins, input.minCount)}`);
  }
  return { text: lines.join("\n"), raceCount: races.count, raceCountTruncated: races.truncated };
}

/** 百分率は小数第1位。分母が 0 のときは率を作らない。 */
export function formatRate(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${(Math.round((numerator * 1000) / denominator) / 10).toFixed(1)}%`;
}

function courseSideLines(state: CourseSideState | null | undefined): string[] {
  if (!state?.side) return [];
  const lines = [courseSideScopeLine(state.side, state.statsFilter != null)];
  if (state.statsFilter && !state.racesFilter) lines.push("レース数は回りで絞れていない。");
  return lines;
}

function shareLine(label: string, count: number, total: number, minCount: number): string {
  return `- ${label}: ${count}頭（${formatRate(count, total)}）${noteSuffix(count, minCount)}`;
}

function bracketLine(
  label: string,
  row: { starts: number; wins: number; top3: number },
  minCount: number,
): string {
  return `- ${label}: 出走 ${row.starts}　勝ち ${row.wins}　勝率 ${formatRate(row.wins, row.starts)}　複勝 ${row.top3}　複勝率 ${formatRate(row.top3, row.starts)}${noteSuffix(row.starts, minCount)}`;
}

function goingLine(label: string, row: { wins: number; front_wins: number }, minCount: number): string {
  return `- ${label}: 4番手以内 ${row.front_wins}頭 / 勝ち ${row.wins}頭（${formatRate(row.front_wins, row.wins)}）${noteSuffix(row.wins, minCount)}`;
}

function noteSuffix(count: number, minCount: number): string {
  return count < minCount ? ` ${SAMPLE_NOTE}` : "";
}

function raceCountLabel(races: { count: number; truncated: boolean }): string {
  if (races.truncated) return `${races.count}以上（一覧の上限で打ち切り）`;
  return String(races.count);
}

function sumBrackets(
  rows: Array<{ key: string; starts: number; wins: number; top3: number }>,
  from: number,
  to: number,
): { starts: number; wins: number; top3: number } {
  return rows.reduce(
    (sum, row) => {
      const bracket = numericKey(row.key);
      if (bracket == null || bracket < from || bracket > to) return sum;
      return { starts: sum.starts + row.starts, wins: sum.wins + row.wins, top3: sum.top3 + row.top3 };
    },
    { starts: 0, wins: 0, top3: 0 },
  );
}

function sumGoing(
  rows: Array<{ key: string; wins: number; front_wins: number }>,
  names: Set<string>,
): { wins: number; front_wins: number } {
  return rows.reduce(
    (sum, row) => {
      if (!names.has(row.key)) return sum;
      return { wins: sum.wins + row.wins, front_wins: sum.front_wins + row.front_wins };
    },
    { wins: 0, front_wins: 0 },
  );
}

function readSingle(payload: unknown, label: string, keys: string[]): Record<string, number> {
  if (payload == null) throw new JobError(`${label} の集計が無いため、コースデータ要約を作れません`, false);
  assertNotTruncated(payload, label);
  const rows = rowsToObjects(payload);
  if (rows.length > 1) throw new JobError(`${label} の集計が ${rows.length} 行あるため、コースデータ要約を作れません`, false);
  const row = rows[0] ?? {};
  return Object.fromEntries(keys.map((key) => [key, countField(row, key, label)]));
}

function readGrouped(
  payload: unknown,
  label: string,
  keyName: string,
  metrics: Array<"starts" | "wins" | "top3" | "front_wins">,
): Array<{ key: string; starts: number; wins: number; top3: number; front_wins: number }> {
  if (payload == null) throw new JobError(`${label} の集計が無いため、コースデータ要約を作れません`, false);
  assertNotTruncated(payload, label);
  return rowsToObjects(payload).map((row) => {
    const key = stringField(row, keyName) ?? numericLabel(row[keyName]);
    if (!key) throw new JobError(`${label} の区分名が読めないため、コースデータ要約を作れません`, false);
    const counts = { key, starts: 0, wins: 0, top3: 0, front_wins: 0 };
    for (const metric of metrics) counts[metric] = countField(row, metric, label);
    return counts;
  });
}

function readRaceCount(payload: unknown): { count: number; truncated: boolean } {
  if (!payload || typeof payload !== "object") {
    throw new JobError("レース数の応答を読めないため、コースデータ要約を作れません", false);
  }
  const truncated = (payload as { truncated?: unknown }).truncated === true;
  const rows = rowsToObjects(payload);
  const finished = rows.filter((row) => {
    const status = stringField(row, "race_status");
    return status == null || status === "finished";
  });
  const reported = numberField(payload as Record<string, unknown>, "row_count");
  if (!truncated && reported != null && reported !== rows.length) {
    throw new JobError("レース数の row_count と行数が違うため、コースデータ要約を作れません", false);
  }
  return { count: finished.length, truncated };
}

function readDataThrough(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { data_through?: unknown }).data_through;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function assertNotTruncated(payload: unknown, label: string): void {
  if (payload && typeof payload === "object" && (payload as { truncated?: unknown }).truncated === true) {
    throw new JobError(`${label} の集計が打ち切られたため、コースデータ要約を作れません`, false);
  }
}

function countField(row: Record<string, unknown>, key: string, label: string): number {
  if (Object.keys(row).length === 0) return 0;
  const value = numberField(row, key);
  if (value == null || !Number.isInteger(value) || value < 0) {
    throw new JobError(`${label} の ${key} が件数として読めません`, false);
  }
  return value;
}

function numericKey(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

function numericLabel(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return null;
}

function assertSummaryScope(stats: CourseSummaryQuery[], races: Record<string, unknown>): void {
  const blob = JSON.stringify({ stats, races });
  const banned = ["win_payout", "place_payout", "rail_type", "sire_name", "broodmare_sire_name", "jockey_name", "win_odds_rank", "min_starts"];
  const found = banned.filter((name) => blob.includes(name));
  if (found.length > 0) {
    throw new JobError(`コースデータ要約に ${found.join(", ")} は入れません`, false);
  }
}

function addCalendarDays(iso: string, days: number): string {
  const { year, month, day } = parseIsoDate(iso);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function addCalendarYears(iso: string, years: number): string {
  const { year, month, day } = parseIsoDate(iso);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return formatIso(targetYear, month, Math.min(day, lastDay));
}

function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new JobError(`日付「${iso}」を読めません`, false);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new JobError(`日付「${iso}」は暦にありません`, false);
  }
  return { year, month, day };
}

function formatIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
