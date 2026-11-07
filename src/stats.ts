import { assertFields, assertToolArgs, type ToolCatalog } from "./schema";
import { JobError, STATS_CACHE_TTL_SECONDS, type KvStore } from "./types";

/** 4コーナー通過順位の4区分。1呼び出しにつき1区分。 */
export const CORNER_RANGES = [
  { id: "1-3", label: "4角1〜3番手", filter: { lte: 3 } },
  { id: "4-6", label: "4角4〜6番手", filter: { gte: 4, lte: 6 } },
  { id: "7-10", label: "4角7〜10番手", filter: { gte: 7, lte: 10 } },
  { id: "11plus", label: "4角11番手以降", filter: { gte: 11 } },
] as const;

export const COURSE_METRICS = [
  { agg: "count", where: { official_result: 1 }, as: "wins" },
  { agg: "count", where: { official_result: { lte: 3 } }, as: "top3" },
  { agg: "sum", field: "win_payout", as: "win_return" },
];

export type StatKind = "bracket" | "corner" | "sire" | "broodmare_sire" | "jockey" | "track_condition";

export interface StatTask {
  id: string;
  cacheKey: string;
  kind: StatKind;
  label: string;
  args: Record<string, unknown>;
  status: "pending" | "done";
  result?: unknown;
  note?: string;
}

export interface CourseContext {
  venue: string;
  surface: string;
  distance: number;
  yearFrom: number;
  minStarts: number;
  broodmareMinStarts: number;
  sires: string[];
  broodmareSires: string[];
  jockeys: string[];
}

const REQUIRED_FIELDS = [
  "race_track",
  "surface",
  "distance",
  "race_year",
  "bracket_number",
  "fourth_corner_position",
  "sire_name",
  "broodmare_sire_name",
  "jockey_name",
  "track_condition",
  "official_result",
  "win_payout",
  "dimensions",
  "metrics",
  "filters",
  "min_starts",
];

export function buildStatTasks(course: CourseContext, catalog: ToolCatalog): StatTask[] {
  assertFields(catalog, "get_stats", REQUIRED_FIELDS);
  if (!["芝", "ダート", "障害"].includes(course.surface)) {
    throw new JobError(`馬場種類「${course.surface}」は 芝・ダート・障害 のどれでもありません`, false);
  }
  const base = courseFilters(course);
  const tasks: StatTask[] = [
    task("bracket", "枠番", course, course.minStarts, {
      dimensions: ["bracket_number"],
      metrics: COURSE_METRICS,
      filters: base,
      min_starts: course.minStarts,
    }),
    ...CORNER_RANGES.map((range) =>
      task(`corner:${range.id}`, range.label, course, course.minStarts, {
        metrics: COURSE_METRICS,
        filters: { ...base, fourth_corner_position: range.filter },
        min_starts: course.minStarts,
      }),
    ),
    task("track_condition", "馬場状態", course, course.minStarts, {
      dimensions: ["track_condition"],
      metrics: COURSE_METRICS,
      filters: base,
      min_starts: course.minStarts,
    }),
  ];
  if (course.sires.length > 0) {
    tasks.push(
      task("sire", "父", course, course.minStarts, {
        dimensions: ["sire_name"],
        metrics: COURSE_METRICS,
        filters: { ...base, sire_name: course.sires },
        min_starts: course.minStarts,
      }, course.sires),
    );
  }
  if (course.broodmareSires.length > 0) {
    tasks.push(
      task("broodmare_sire", "母父", course, course.broodmareMinStarts, {
        dimensions: ["broodmare_sire_name"],
        metrics: COURSE_METRICS,
        filters: { ...base, broodmare_sire_name: course.broodmareSires },
        min_starts: course.broodmareMinStarts,
      }, course.broodmareSires),
    );
  }
  for (const jockey of course.jockeys) {
    tasks.push(
      task(`jockey:${jockey}`, `騎手 ${jockey}`, course, course.minStarts, {
        metrics: COURSE_METRICS,
        filters: { ...base, jockey_name: jockey },
        min_starts: course.minStarts,
      }, [jockey]),
    );
  }
  for (const stat of tasks) assertToolArgs(catalog, "get_stats", stat.args);
  assertNoPopularity(tasks);
  return tasks;
}

export async function hydrateStatCache(tasks: StatTask[], kv: KvStore): Promise<void> {
  await Promise.all(
    tasks.map(async (task) => {
      const cached = await kv.get(task.cacheKey);
      if (!cached) return;
      task.status = "done";
      try {
        task.result = JSON.parse(cached) as unknown;
      } catch {
        throw new JobError(`KV の ${task.cacheKey} を JSON として読めません`, false);
      }
      task.note = "KV cache";
    }),
  );
}

export async function writeStatCache(task: StatTask, kv: KvStore, fetchedAt: string): Promise<void> {
  await kv.put(
    task.cacheKey,
    JSON.stringify({ fetchedAt, payload: task.result }),
    { expirationTtl: STATS_CACHE_TTL_SECONDS },
  );
}

export function yearFrom(raceYear: number, periodYears: number): number {
  return raceYear - periodYears + 1;
}

function courseFilters(course: CourseContext): Record<string, unknown> {
  return {
    race_track: course.venue,
    surface: course.surface,
    distance: course.distance,
    race_year: { gte: course.yearFrom },
  };
}

function task(
  id: string,
  label: string,
  course: CourseContext,
  minStarts: number,
  args: Record<string, unknown>,
  names: string[] = [],
): StatTask {
  const kind = id.split(":")[0] as StatKind;
  const nameKey = names.length > 0 ? names.slice().sort().join(",") : "-";
  const cacheKey = [
    "stats:v2",
    id.startsWith("jockey:") ? "jockey" : id,
    course.venue,
    course.surface,
    String(course.distance),
    String(course.yearFrom),
    String(minStarts),
    nameKey,
  ].join(":");
  return { id, cacheKey, kind, label, args, status: "pending" };
}

function assertNoPopularity(tasks: StatTask[]): void {
  const blob = JSON.stringify(tasks);
  if (blob.includes("win_odds_rank")) {
    throw new JobError("人気別の集計は作りません", false);
  }
}
