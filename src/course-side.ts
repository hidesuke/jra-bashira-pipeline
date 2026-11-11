import { stringField } from "./rows";
import type { ToolCatalog } from "./schema";

/**
 * BASHIRA の course_side。
 * 外→内・内→外は途中で回りが変わるコースで、内や外にはまとめない。
 * なしは印が無い（東京の芝、直線、印の無いダート・障害）。
 */
export const COURSE_SIDES = ["内", "外", "外→内", "内→外", "なし"] as const;

export type CourseSide = (typeof COURSE_SIDES)[number];

const FILTERING = new Set<CourseSide>(["内", "外", "外→内", "内→外"]);

export const MISSING_COURSE_SIDE = "内外回り（BASHIRA に項目が無い）";
export const EMPTY_COURSE_SIDE = "内外回り（値が無い）";
export const UNREADABLE_COURSE_SIDE = "内外回り（値が読めない）";
export const UNFILTERED_COURSE_SIDE = "内外回り（get_stats に course_side が無いため絞っていない）";

export interface CourseSideState {
  /** 入力に書く値。無いときは null。 */
  side: CourseSide | null;
  /** 空欄、または絞れなかった理由。問題が無ければ null。 */
  gap: string | null;
  /** get_stats の filters に入れる値。絞らないときは null。 */
  statsFilter: CourseSide | null;
  /** コースデータ要約のレース数（get_races）に入れる値。絞らないときは null。 */
  racesFilter: CourseSide | null;
}

export function unresolvedCourseSide(): CourseSideState {
  return resolveCourseSide({ raw: null, raceField: false, statsField: false, racesField: false });
}

export function resolveCourseSide(input: {
  raw: string | null;
  /** get_races のスキーマに course_side がある。 */
  raceField: boolean;
  /** get_stats のスキーマに course_side がある。 */
  statsField: boolean;
  /** get_races のフィルタとして course_side を使える。列と同じスキーマ名で見る。 */
  racesField: boolean;
}): CourseSideState {
  if (!input.raceField) {
    return { side: null, gap: MISSING_COURSE_SIDE, statsFilter: null, racesFilter: null };
  }
  const raw = input.raw?.trim() ?? "";
  if (!raw) {
    return { side: null, gap: EMPTY_COURSE_SIDE, statsFilter: null, racesFilter: null };
  }
  if (!isCourseSide(raw)) {
    return { side: null, gap: UNREADABLE_COURSE_SIDE, statsFilter: null, racesFilter: null };
  }
  if (!FILTERING.has(raw)) {
    return { side: raw, gap: null, statsFilter: null, racesFilter: null };
  }
  const statsFilter = input.statsField ? raw : null;
  // 成績を絞れないときは、レース数だけ絞ると要約の母数がずれる。両方そろったときだけレース数も絞る。
  const racesFilter = statsFilter && input.racesField ? raw : null;
  return {
    side: raw,
    gap: statsFilter ? null : UNFILTERED_COURSE_SIDE,
    statsFilter,
    racesFilter,
  };
}

export function courseSideFromCatalog(row: Record<string, unknown> | null, catalog: ToolCatalog): CourseSideState {
  const raceField = hasField(catalog, "get_races", "course_side");
  return resolveCourseSide({
    raw: row ? stringField(row, "course_side") : null,
    raceField,
    statsField: hasField(catalog, "get_stats", "course_side"),
    racesField: raceField,
  });
}

export function isCourseSide(value: string): value is CourseSide {
  return (COURSE_SIDES as readonly string[]).includes(value);
}

/** 絞るときだけキーの末尾に足す。なしと不明は空で、今のキーのまま。 */
export function courseSideKeySuffix(filter: CourseSide | null | undefined): string {
  if (!filter) return "";
  return `:side:${encodeURIComponent(filter)}`;
}

export function withCourseSideFilter(
  filters: Record<string, unknown>,
  side: CourseSide | null | undefined,
): Record<string, unknown> {
  if (!side) return filters;
  return { ...filters, course_side: side };
}

/**
 * コースデータ要約と出走馬のコース成績に置く1行。
 * 母数が少なくても、絞った回りを内や外と混ぜた数字には戻さない。
 */
export function courseSideScopeLine(side: CourseSide, filtered: boolean): string {
  if (side === "なし") return "回り: なし（内外の印は無い。集計は絞らない）";
  if (!filtered) return `回り: ${side}（get_stats に course_side が無いため、集計は絞っていない）`;
  return `回り: ${side}（この回りだけを集計。母数が少なくても内と外は混ぜない）`;
}

export function isCourseSideScopeLine(line: string): boolean {
  return COURSE_SIDES.some((side) => line === courseSideScopeLine(side, true) || line === courseSideScopeLine(side, false));
}

/** コース分析の user に {{course_side}} が無いとき、先頭へ足す文。値が無いときは空。 */
export function courseSideLead(state: CourseSideState): string {
  if (!state.side) return "";
  return [`内外回り: ${state.side}`, courseSideScopeLine(state.side, state.statsFilter != null)].join("\n");
}

function hasField(catalog: ToolCatalog, toolName: string, field: string): boolean {
  return catalog.tools[toolName]?.fields.includes(field) ?? false;
}
