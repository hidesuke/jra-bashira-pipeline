import { ambiguousNameMessage } from "./bashira/mcp";
import type { BashiraPort } from "./bashira/port";
import { selectPastRuns, type FormTask } from "./form";
import type { CourseSpec } from "./related-courses";
import { comparableMeetingDay, meetingDay, numberField, rowsToObjects, stringField } from "./rows";
import { assertFields, assertToolArgs, selectColumns, type ToolCatalog } from "./schema";
import { CODE_BY_VENUE, JobError, type RaceRef } from "./types";

/** get_entries の上限。続きを取る offset は無い。 */
export const ENTRIES_ROW_LIMIT = 500;
/**
 * 1 回に見積もる行数。500 より手前で分け、今回のレース行の余裕を残す。
 * 超えた馬は別の get_entries に分ける。
 */
export const CAREER_ROW_BUDGET = 450;
/** 馬名フィルタの配列上限（BASHIRA の name_value）。 */
export const NAME_FILTER_LIMIT = 100;
/**
 * predict 1 配送で出す通算の get_entries。
 * 通常は 1 回。打ち切りで分割してもここまで。Notion 段の 45 とは別配送。
 */
export const CAREER_FETCH_LIMIT = 8;
/** get_races の race_id 配列上限。 */
export const PACE_ID_CHUNK = 100;
/** 近10走は最大 18頭×10。重複を除くと 200 件未満なので 2 回で足りる。 */
export const PACE_FETCH_LIMIT = 2;

const SCRATCHED = new Set(["出走取消", "発走除外", "競走除外"]);
const NON_FINISH = new Set(["出走取消", "発走除外", "競走除外", "競走中止", "失格", "落馬再騎乗"]);

const CAREER_COLUMNS = [
  "horse_name",
  "horse_number",
  "race_meeting_date",
  "race_track",
  "race_number",
  "surface",
  "distance",
  "rail_type",
  "track_condition",
  "race_condition",
  "race_type",
  "grade",
  "race_name_main",
  "official_result",
  "finish_time_sec",
  "time_difference_with_winner_sec",
  "first_corner_position",
  "second_corner_position",
  "third_corner_position",
  "fourth_corner_position",
  "last_3f_sec",
  "last_3f_rank",
  "weight_to_carry_kg",
  "jockey_name",
  "scheduled_horse_count",
  "win_odds",
  "win_odds_rank",
  "entry_status",
  "race_abnormality",
  "local_overseas_type",
  "dead_heat",
  "horse_weight",
  "horse_weight_difference_with_previous_race",
  "days_since_last_race",
] as const;

const OPTIONAL_CAREER_COLUMNS = ["is_jockey_change"] as const;

const PACE_COLUMNS = ["race_id", "race_meeting_date", "race_track", "race_number", "first_3f_sec", "last_3f_sec"] as const;

export const PAST_RUN_HEADER = [
  "日付",
  "競馬場",
  "レース名",
  "グレード",
  "クラス",
  "馬場",
  "距離",
  "コース",
  "馬場状態",
  "頭数",
  "着順",
  "タイム",
  "着差",
  "上り3F",
  "上り順位",
  "通過",
  "騎手",
  "乗替",
  "斤量",
  "馬体重",
  "増減",
  "馬番",
  "間隔",
  "人気",
  "単勝",
  "前半3F",
  "後半3F",
  "条件",
];

/** 条件列を足す前の27列。保存済みの表を読むときだけ使う。新しく書く表には使わない。 */
export const PAST_RUN_LEGACY_HEADER = PAST_RUN_HEADER.slice(0, -1);

/** 一次予想へ渡す近10走の見出し。抽出もこの文字列だけを許可する。 */
export const PAST_RUNS_TITLE = "# 過去走（近10走）";
export const PAST_RUNS_INTRO =
  "各馬最大10走。今回のレースと upcoming、開催日より未来の走は除く。人気と単勝は過去のレースの値。前半3Fと後半3Fはそのレース全体の秒。上り3Fは馬の上がり。空欄は値が無い。乗替はあり／なし。";
export const COURSE_RECORDS_TITLE = "# コース成績";
export const COURSE_RECORDS_INTRO =
  "表記は (1着,2着,3着,4着,5着,それ以外)。同じコースは競馬場・芝かダート・距離が同じ。同じ競馬場は競馬場と芝かダートが同じ。関連コースは一覧の合算。内回り・外回りは区別しない。着順の付かない走（取消・除外・中止・失格）は数えない。";
export const RELATED_COURSES_UNREADABLE_LINE = "関連コース: 一覧が読めないため空欄";
export const RELATED_COURSES_NONE_LINE = "関連コース: なし";
export const PAST_RUN_UNRESOLVED = "同名馬のため近走取得不可";
export const PAST_RUN_NONE = "近走なし";
export const COURSE_RECORD_UNRESOLVED = "同名馬のため成績を数えない";
export const COURSE_SAME_EMPTY = "同じコース: ";
export const COURSE_TRACK_EMPTY = "同じ競馬場: ";
export const COURSE_RELATED_EMPTY = "関連コース: ";

export function pastRunHeaderLine(): string {
  return markdownCells(PAST_RUN_HEADER);
}

export function pastRunRuleLine(): string {
  return markdownRule(PAST_RUN_HEADER);
}

export function pastRunLegacyHeaderLine(): string {
  return markdownCells(PAST_RUN_LEGACY_HEADER);
}

export function pastRunLegacyRuleLine(): string {
  return markdownRule(PAST_RUN_LEGACY_HEADER);
}

/** 見出し行なら、その列名。今の28列と、条件列が無い27列のどちらも受ける。 */
export function pastRunTableHeader(line: string): readonly string[] | null {
  if (line === pastRunHeaderLine()) return PAST_RUN_HEADER;
  if (line === pastRunLegacyHeaderLine()) return PAST_RUN_LEGACY_HEADER;
  return null;
}

export function pastRunRuleFor(header: readonly string[]): string {
  return markdownRule(header);
}

export const PAST_RUN_COLUMN_COUNT = PAST_RUN_HEADER.length;

/** スキーマの競走種別。スペースは項目内の区切りで、条件列の表記には入れない。 */
const RACE_TYPE_LABEL: Record<string, string> = {
  "2歳": "2歳",
  "3歳": "3歳",
  "3歳以上": "3歳以上",
  "4歳以上": "4歳以上",
  "障害 3歳以上": "障害3歳以上",
  "障害 4歳以上": "障害4歳以上",
  "アラ系 2歳": "アラ系2歳",
  "アラ系 3歳": "アラ系3歳",
  "アラ系 3歳以上": "アラ系3歳以上",
  "アラ系 4歳以上": "アラ系4歳以上",
};

/**
 * 条件列。特別競走かどうかは見ない。
 * race_type と race_condition が両方あり、種別がこの一覧のときだけつなぐ。
 * 例は 3歳以上2勝クラス、2歳未勝利、3歳以上オープン、障害3歳以上未勝利。
 * どちらかが無い、または種別が一覧に無いときは空欄。クラスの言い換えはしない。
 */
export function pastRunCondition(row: Record<string, unknown>): string {
  const type = stringField(row, "race_type");
  const condition = stringField(row, "race_condition");
  if (!type || !condition) return "";
  const label = RACE_TYPE_LABEL[type];
  if (!label) return "";
  return `${label}${condition}`;
}

function markdownCells(header: readonly string[]): string {
  return `| ${header.join(" | ")} |`;
}

function markdownRule(header: readonly string[]): string {
  return `| ${header.map(() => "---").join(" | ")} |`;
}

/** コース成績の先頭に書く関連コースの行。null は一覧が読めない。 */
export function renderRelatedCoursesLine(related: CourseSpec[] | null): string {
  if (related == null) return RELATED_COURSES_UNREADABLE_LINE;
  if (related.length === 0) return RELATED_COURSES_NONE_LINE;
  return `関連コース: ${related.map((course) => `${course.track},${course.surface},${course.distance}`).join(" / ")}`;
}

export interface CareerHorse {
  horseName: string;
  /** 同名を生年で解決したあとの名前。未解決の馬は問い合わせに使わない。 */
  queryName: string;
  horseNumber: number | null;
  careerStarts: number | null;
  unresolved: boolean;
}

export interface PlaceCounts {
  first: number;
  second: number;
  third: number;
  fourth: number;
  fifth: number;
  other: number;
}

export interface RacePace {
  first3f: number | null;
  last3f: number | null;
}

export interface PastPerformance {
  rows: Record<string, unknown>[];
  paces: Map<string, RacePace>;
  gaps: string[];
  careerCalls: number;
  paceCalls: number;
}

export function careerHorses(entries: Record<string, unknown>[], tasks: FormTask[]): CareerHorse[] {
  const forms = new Map(tasks.map((task) => [task.horseName, task]));
  const horses = [...entries].sort((a, b) => (numberField(a, "horse_number") ?? 99) - (numberField(b, "horse_number") ?? 99));
  const seen = new Set<string>();
  const result: CareerHorse[] = [];
  for (const entry of horses) {
    const horseName = stringField(entry, "horse_name");
    if (!horseName || seen.has(horseName)) continue;
    const abnormality = stringField(entry, "race_abnormality");
    if (abnormality && SCRATCHED.has(abnormality)) continue;
    seen.add(horseName);
    const task = forms.get(horseName);
    const unresolved = task?.resolution?.status === "unresolved";
    result.push({
      horseName,
      queryName: task?.resolution?.resolvedName ?? horseName,
      horseNumber: numberField(entry, "horse_number"),
      careerStarts: numberField(entry, "career_starts"),
      unresolved,
    });
  }
  return result;
}

/** 見積もり行数か馬名 100 件で分ける。1 頭は 1 回に収める。 */
export function planCareerBatches(horses: CareerHorse[]): CareerHorse[][] {
  const targets = horses.filter((horse) => !horse.unresolved);
  const batches: CareerHorse[][] = [];
  let current: CareerHorse[] = [];
  let rows = 0;
  for (const horse of targets) {
    const estimate = estimateRows(horse);
    const overflow = current.length > 0 && (current.length >= NAME_FILTER_LIMIT || rows + estimate > CAREER_ROW_BUDGET);
    if (overflow) {
      batches.push(current);
      current = [];
      rows = 0;
    }
    current.push(horse);
    rows += estimate;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function careerQuery(race: RaceRef, horses: CareerHorse[], columns: string[]): Record<string, unknown> {
  const names = horses.map((horse) => horse.queryName);
  return {
    filters: {
      horse_name: names.length === 1 ? names[0] : names,
      race_meeting_date: { lte: race.date },
    },
    columns,
    limit: ENTRIES_ROW_LIMIT,
    order_by: "race_meeting_date",
    order: "desc",
  };
}

export function paceRaceIds(race: RaceRef, horses: CareerHorse[], rows: Record<string, unknown>[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const horse of horses) {
    if (horse.unresolved) continue;
    const mine = selectPastRuns(rows, race, horse.horseName, horse.queryName);
    for (const row of mine) {
      const overseas = stringField(row, "local_overseas_type");
      if (overseas && overseas !== "JRA") continue;
      const id = raceIdOf(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function planPaceQueries(ids: string[]): Record<string, unknown>[] {
  const queries: Record<string, unknown>[] = [];
  const capped = ids.slice(0, PACE_ID_CHUNK * PACE_FETCH_LIMIT);
  for (let index = 0; index < capped.length; index += PACE_ID_CHUNK) {
    const chunk = capped.slice(index, index + PACE_ID_CHUNK);
    queries.push({
      filters: { race_id: chunk.length === 1 ? chunk[0] : chunk },
      columns: [...PACE_COLUMNS],
      limit: chunk.length,
    });
  }
  return queries;
}

/** `2026-10-12` または `2026-10-12T00:00:00Z` の東京 11R → `20261012-05-11`。場コードが無い競馬場は null。 */
export function raceIdOf(row: Record<string, unknown>): string | null {
  const date = meetingDay(stringField(row, "race_meeting_date"));
  const track = stringField(row, "race_track");
  const number = numberField(row, "race_number");
  if (!date || !track || number == null) return null;
  const code = CODE_BY_VENUE[track];
  if (!code) return null;
  const compact = date.replace(/-/g, "");
  if (!/^\d{8}$/.test(compact)) return null;
  const raceNumber = Math.trunc(number);
  if (raceNumber < 1 || raceNumber > 99) return null;
  return `${compact}-${code}-${String(raceNumber).padStart(2, "0")}`;
}

export async function loadPastPerformance(input: {
  bashira: BashiraPort;
  catalog: ToolCatalog;
  race: RaceRef;
  horses: CareerHorse[];
}): Promise<PastPerformance> {
  const targets = input.horses.filter((horse) => !horse.unresolved);
  if (targets.length === 0) return { rows: [], paces: new Map(), gaps: [], careerCalls: 0, paceCalls: 0 };
  const columns = careerColumns(input.catalog);
  const gaps: string[] = [];
  if (!columns.includes("is_jockey_change")) gaps.push("乗り替わり（get_entries に is_jockey_change が無い）");
  const budget = { calls: 0 };
  const rows: Record<string, unknown>[] = [];
  for (const batch of planCareerBatches(targets)) {
    const got = await fetchCareerBatch(input.bashira, input.catalog, input.race, batch, columns, budget);
    rows.push(...got.rows);
    gaps.push(...got.gaps);
  }
  const ids = paceRaceIds(input.race, input.horses, rows);
  const pace = await fetchPaces(input.bashira, input.catalog, ids);
  return { rows, paces: pace.paces, gaps: [...gaps, ...pace.gaps], careerCalls: budget.calls, paceCalls: pace.calls };
}

export function formatPlaceCounts(counts: PlaceCounts): string {
  return `(${counts.first},${counts.second},${counts.third},${counts.fourth},${counts.fifth},${counts.other})`;
}

export function emptyPlaceCounts(): PlaceCounts {
  return { first: 0, second: 0, third: 0, fourth: 0, fifth: 0, other: 0 };
}

/** 着順が付いた走だけ数える。取消・除外・中止・失格は入れない。 */
export function isCountableRun(row: Record<string, unknown>, race: RaceRef): boolean {
  if (stringField(row, "entry_status") === "upcoming") return false;
  const date = comparableMeetingDay(stringField(row, "race_meeting_date"));
  const track = stringField(row, "race_track");
  const number = numberField(row, "race_number");
  if (date === race.date && track === race.venue && number === race.raceNumber) return false;
  if (date && date > race.date) return false;
  const abnormality = stringField(row, "race_abnormality");
  const place = numberField(row, "official_result");
  if (abnormality && NON_FINISH.has(abnormality)) return false;
  if (place == null || place < 1) return false;
  return true;
}

export function countPlaces(rows: Record<string, unknown>[], race: RaceRef, predicate: (row: Record<string, unknown>) => boolean): PlaceCounts {
  const counts = emptyPlaceCounts();
  for (const row of rows) {
    if (!isCountableRun(row, race) || !predicate(row)) continue;
    const place = numberField(row, "official_result") ?? 0;
    if (place === 1) counts.first += 1;
    else if (place === 2) counts.second += 1;
    else if (place === 3) counts.third += 1;
    else if (place === 4) counts.fourth += 1;
    else if (place === 5) counts.fifth += 1;
    else if (place >= 6) counts.other += 1;
  }
  return counts;
}

export function renderPastRuns(input: {
  race: RaceRef;
  horses: CareerHorse[];
  rows: Record<string, unknown>[];
  paces: Map<string, RacePace>;
}): string {
  const lines = [PAST_RUNS_TITLE, PAST_RUNS_INTRO];
  for (const horse of input.horses) {
    lines.push("", horseHeading(horse), renderHorsePastRuns(input.race, horse, input.rows, input.paces));
  }
  return lines.join("\n");
}

export function renderCourseRecords(input: {
  race: RaceRef;
  horses: CareerHorse[];
  rows: Record<string, unknown>[];
  current: { track: string; surface: string; distance: number } | null;
  /** null は一覧が読めない。空配列は関連コースが無い。 */
  related: CourseSpec[] | null;
}): string {
  const lines = [COURSE_RECORDS_TITLE, COURSE_RECORDS_INTRO, renderRelatedCoursesLine(input.related)];
  for (const horse of input.horses) {
    lines.push("", horseHeading(horse));
    if (horse.unresolved) {
      lines.push(COURSE_RECORD_UNRESOLVED, COURSE_SAME_EMPTY, COURSE_TRACK_EMPTY, COURSE_RELATED_EMPTY);
      continue;
    }
    const mine = input.rows.filter((row) => matchesHorse(row, horse));
    lines.push(
      `同じコース: ${input.current ? formatPlaceCounts(countPlaces(mine, input.race, (row) => sameCourse(row, input.current!))) : ""}`,
      `同じ競馬場: ${input.current ? formatPlaceCounts(countPlaces(mine, input.race, (row) => sameTrack(row, input.current!))) : ""}`,
      `関連コース: ${input.related ? formatPlaceCounts(countPlaces(mine, input.race, (row) => onRelated(row, input.related!))) : ""}`,
    );
  }
  return lines.join("\n");
}

function careerColumns(catalog: ToolCatalog): string[] {
  assertFields(catalog, "get_entries", ["filters", "columns", "limit", "order_by", "order", ...CAREER_COLUMNS]);
  return selectColumns(catalog, "get_entries", CAREER_COLUMNS, OPTIONAL_CAREER_COLUMNS);
}

async function fetchCareerBatch(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  race: RaceRef,
  horses: CareerHorse[],
  columns: string[],
  budget: { calls: number },
): Promise<{ rows: Record<string, unknown>[]; gaps: string[] }> {
  if (horses.length === 0) return { rows: [], gaps: [] };
  if (budget.calls >= CAREER_FETCH_LIMIT) {
    return { rows: [], gaps: horses.map((horse) => `${horse.horseName}の通算（取得回数の上限で打ち切った）`) };
  }
  const args = careerQuery(race, horses, columns);
  assertToolArgs(catalog, "get_entries", args);
  budget.calls += 1;
  const result = await bashira.callTool("get_entries", args);
  if (!result.ok) throw toolFailure(result);
  const ambiguity = ambiguousNameMessage(result.data);
  if (ambiguity) throw new JobError(ambiguity, false);
  if (isTruncated(result.data) && horses.length > 1) {
    const mid = Math.ceil(horses.length / 2);
    const left = await fetchCareerBatch(bashira, catalog, race, horses.slice(0, mid), columns, budget);
    const right = await fetchCareerBatch(bashira, catalog, race, horses.slice(mid), columns, budget);
    return { rows: [...left.rows, ...right.rows], gaps: [...left.gaps, ...right.gaps] };
  }
  const gaps = isTruncated(result.data) ? horses.map((horse) => `${horse.horseName}の通算（get_entries が500行で打ち切られた）`) : [];
  return { rows: rowsToObjects(result.data), gaps };
}

async function fetchPaces(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  ids: string[],
): Promise<{ paces: Map<string, RacePace>; gaps: string[]; calls: number }> {
  const paces = new Map<string, RacePace>();
  if (ids.length === 0) return { paces, gaps: [], calls: 0 };
  const shape = catalog.tools.get_races;
  const needed = ["filters", "columns", "limit", ...PACE_COLUMNS];
  if (!shape || needed.some((field) => !shape.fields.includes(field))) {
    return { paces, gaps: ["前半3F・後半3F（get_races の列が無い）"], calls: 0 };
  }
  const gaps: string[] = [];
  if (ids.length > PACE_ID_CHUNK * PACE_FETCH_LIMIT) gaps.push("前半3F・後半3F（race_id が2回分を超えた）");
  const queries = planPaceQueries(ids);
  let calls = 0;
  for (const args of queries) {
    assertToolArgs(catalog, "get_races", args);
    calls += 1;
    const result = await bashira.callTool("get_races", args);
    if (!result.ok) throw toolFailure(result);
    const ambiguity = ambiguousNameMessage(result.data);
    if (ambiguity) throw new JobError(ambiguity, false);
    if (isTruncated(result.data)) gaps.push("前半3F・後半3F（get_races が打ち切られた）");
    for (const row of rowsToObjects(result.data)) {
      const id = stringField(row, "race_id");
      if (!id) continue;
      paces.set(id, { first3f: numberField(row, "first_3f_sec"), last3f: numberField(row, "last_3f_sec") });
    }
  }
  return { paces, gaps, calls };
}

function renderHorsePastRuns(race: RaceRef, horse: CareerHorse, rows: Record<string, unknown>[], paces: Map<string, RacePace>): string {
  if (horse.unresolved) return PAST_RUN_UNRESOLVED;
  const runs = selectPastRuns(rows, race, horse.horseName, horse.queryName);
  if (runs.length === 0) return PAST_RUN_NONE;
  return [pastRunHeaderLine(), pastRunRuleLine(), ...runs.map((row) => pastRunRow(row, paces))].join("\n");
}

function pastRunRow(row: Record<string, unknown>, paces: Map<string, RacePace>): string {
  const pace = paceOf(row, paces);
  const rawDate = stringField(row, "race_meeting_date");
  const cells = [
    meetingDay(rawDate) ?? rawDate ?? "",
    stringField(row, "race_track") ?? "",
    stringField(row, "race_name_main") ?? "",
    stringField(row, "grade") ?? "",
    stringField(row, "race_condition") ?? "",
    stringField(row, "surface") ?? "",
    num(numberField(row, "distance")),
    stringField(row, "rail_type") ?? "",
    stringField(row, "track_condition") ?? "",
    num(numberField(row, "scheduled_horse_count")),
    finishCell(row),
    formatFinishTime(numberField(row, "finish_time_sec")),
    num(numberField(row, "time_difference_with_winner_sec")),
    num(numberField(row, "last_3f_sec")),
    num(numberField(row, "last_3f_rank")),
    passing(row),
    stringField(row, "jockey_name") ?? "",
    jockeyChange(row),
    num(numberField(row, "weight_to_carry_kg")),
    num(numberField(row, "horse_weight")),
    signed(numberField(row, "horse_weight_difference_with_previous_race")),
    num(numberField(row, "horse_number")),
    num(numberField(row, "days_since_last_race")),
    num(numberField(row, "win_odds_rank")),
    num(numberField(row, "win_odds")),
    num(pace.first3f),
    num(pace.last3f),
    pastRunCondition(row),
  ];
  return `| ${cells.map(cell).join(" | ")} |`;
}

function paceOf(row: Record<string, unknown>, paces: Map<string, RacePace>): RacePace {
  const id = raceIdOf(row);
  if (!id) return { first3f: null, last3f: null };
  return paces.get(id) ?? { first3f: null, last3f: null };
}

function sameCourse(row: Record<string, unknown>, current: { track: string; surface: string; distance: number }): boolean {
  return stringField(row, "race_track") === current.track && stringField(row, "surface") === current.surface && numberField(row, "distance") === current.distance;
}

function sameTrack(row: Record<string, unknown>, current: { track: string; surface: string }): boolean {
  return stringField(row, "race_track") === current.track && stringField(row, "surface") === current.surface;
}

function onRelated(row: Record<string, unknown>, related: CourseSpec[]): boolean {
  const track = stringField(row, "race_track");
  const surface = stringField(row, "surface");
  const distance = numberField(row, "distance");
  if (!track || !surface || distance == null) return false;
  return related.some((course) => course.track === track && course.surface === surface && course.distance === distance);
}

function matchesHorse(row: Record<string, unknown>, horse: CareerHorse): boolean {
  const name = stringField(row, "horse_name");
  return name === horse.horseName || name === horse.queryName;
}

function horseHeading(horse: CareerHorse): string {
  const number = horse.horseNumber == null ? "?" : trimNum(horse.horseNumber);
  return `### ${number} ${horse.horseName}`;
}

function finishCell(row: Record<string, unknown>): string {
  const abnormality = stringField(row, "race_abnormality");
  const place = numberField(row, "official_result");
  const replaces = abnormality != null && abnormality !== "異常なし" && (place == null || NON_FINISH.has(abnormality));
  if (replaces && abnormality) return abnormality;
  if (place == null) return "";
  const extra = [
    abnormality && abnormality !== "異常なし" ? abnormality : null,
    stringField(row, "entry_status") === "provisional" ? "速報" : null,
    row.dead_heat === true ? "同着" : null,
  ].filter((part): part is string => Boolean(part));
  const base = trimNum(place);
  return extra.length > 0 ? `${base}（${extra.join("・")}）` : base;
}

function jockeyChange(row: Record<string, unknown>): string {
  if (!("is_jockey_change" in row)) return "";
  if (row.is_jockey_change === true) return "あり";
  if (row.is_jockey_change === false) return "なし";
  return "";
}

function passing(row: Record<string, unknown>): string {
  const corners = ["first_corner_position", "second_corner_position", "third_corner_position", "fourth_corner_position"].map((key) => num(numberField(row, key)));
  return corners.every((corner) => corner === "") ? "" : corners.map((corner) => corner || "—").join("-");
}

function formatFinishTime(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 60) return trimNum(sec);
  const minutes = Math.floor(sec / 60);
  const rest = (sec - minutes * 60).toFixed(1);
  return `${minutes}:${rest.padStart(4, "0")}`;
}

function signed(value: number | null): string {
  if (value == null) return "";
  if (value > 0) return `+${trimNum(value)}`;
  return trimNum(value);
}

function num(value: number | null): string {
  return value == null ? "" : trimNum(value);
}

function cell(value: string): string {
  return value.replace(/\|/g, "／").replace(/\r?\n/g, " ");
}

function estimateRows(horse: CareerHorse): number {
  if (horse.careerStarts == null) return 40;
  return Math.min(ENTRIES_ROW_LIMIT, Math.max(1, horse.careerStarts) + 2);
}

function isTruncated(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { truncated?: unknown }).truncated === true);
}

function toolFailure(result: { message: string; retryable: boolean; code: string }): never {
  throw new JobError(result.message, result.code === "auth" ? false : result.retryable);
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
