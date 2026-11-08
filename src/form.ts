import { readNameResolutions, type NameCandidate } from "./bashira/mcp";
import { rowsToObjects, numberField, stringField } from "./rows";
import { assertFields, assertToolArgs, type ToolCatalog } from "./schema";
import { DO_EXTERNAL_BUDGET, EXTERNAL_BUDGET, type RaceRef } from "./types";

/** 近走は新しい順に最大 10 走。今回のレース行を落とす余裕を見て 12 行取る。 */
export const PAST_RUN_LIMIT = 10;
export const PAST_QUERY_LIMIT = 12;
export const FORM_BATCH_SIZE = 8;
/**
 * 1 回の form 配送で出す get_entries。
 * 馬名が曖昧な馬だけ生年付きで 1 回引き直すので、バッチ 8 頭でも最大 16。
 * DO の 40 と Worker 側の 45 より少ない。超えたらその馬は pending のまま次の配送へ戻す。
 */
export const FORM_FETCH_LIMIT = Math.min(DO_EXTERNAL_BUDGET, EXTERNAL_BUDGET, FORM_BATCH_SIZE * 2);

export const PAST_COLUMNS = [
  "horse_name",
  "race_meeting_date",
  "race_track",
  "race_number",
  "surface",
  "distance",
  "rail_type",
  "track_condition",
  "weather",
  "race_condition",
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
] as const;

/** 出馬表の行から近走が取れないときに馬柱へ残す事実。 */
export interface EntryFacts {
  birthDate: string | null;
  birthYear: number | null;
  careerStarts: number | null;
  prevOfficialResult: number | null;
  prevDistance: number | null;
  prevSurface: string | null;
  daysSinceLastRace: number | null;
  weightToCarryKg: number | null;
}

export type FormResolutionStatus = "unique" | "resolved_by_birth_year" | "unresolved";

/** 馬名解決の結果。ジョブの formTasks に残す。 */
export interface FormResolution {
  status: FormResolutionStatus;
  resolvedName: string | null;
  birthYear: number | null;
  candidates: NameCandidate[];
}

export interface FormTask {
  horseName: string;
  horseNumber: number | null;
  status: "pending" | "done";
  args: Record<string, unknown>;
  rows: Record<string, unknown>[];
  note?: string;
  facts?: EntryFacts;
  resolution?: FormResolution;
}

export interface PastRunFact {
  raceName: string | null;
  date: string | null;
  officialResult: number | null;
  surface: string | null;
  distance: number | null;
}

/** 予想に渡した馬ごとの成績。一貫性チェックと管理 API が読む。 */
export interface HorseFormSnapshot {
  horseName: string;
  horseNumber: number | null;
  resolvedName: string | null;
  resolutionStatus: FormResolutionStatus | "pending" | "scratched" | "missing";
  pastRunCount: number;
  birthDate: string | null;
  careerStarts: number | null;
  prevOfficialResult: number | null;
  prevDistance: number | null;
  prevSurface: string | null;
  daysSinceLastRace: number | null;
  weightToCarryKg: number | null;
  pastRuns: PastRunFact[];
}

export function buildFormTasks(
  entries: Record<string, unknown>[],
  race: RaceRef,
  catalog: ToolCatalog,
): FormTask[] {
  assertFields(catalog, "get_entries", ["filters", "columns", "limit", "order_by", "order", ...PAST_COLUMNS]);
  const seen = new Set<string>();
  const tasks: FormTask[] = [];
  for (const entry of entries) {
    const horseName = stringField(entry, "horse_name");
    if (!horseName || seen.has(horseName)) continue;
    seen.add(horseName);
    const args = {
      filters: {
        horse_name: horseName,
        race_meeting_date: { lte: race.date },
      },
      columns: [...PAST_COLUMNS],
      limit: PAST_QUERY_LIMIT,
      order_by: "race_meeting_date",
      order: "desc",
    };
    assertToolArgs(catalog, "get_entries", args);
    tasks.push({
      horseName,
      horseNumber: numberField(entry, "horse_number"),
      status: "pending",
      args,
      rows: [],
      facts: entryFacts(entry),
    });
  }
  return tasks;
}

/** 今回のレースと、まだ走っていない行を除き、新しい順に最大 10 走。 */
export function selectPastRuns(
  rows: Record<string, unknown>[],
  race: RaceRef,
  horseName: string,
  resolvedName?: string | null,
): Record<string, unknown>[] {
  const kept = rows.filter((row) => {
    const name = stringField(row, "horse_name");
    if (name && name !== horseName && name !== resolvedName) return false;
    if (stringField(row, "entry_status") === "upcoming") return false;
    const date = stringField(row, "race_meeting_date");
    const track = stringField(row, "race_track");
    const number = numberField(row, "race_number");
    if (date === race.date && track === race.venue && number === race.raceNumber) return false;
    if (date && date > race.date) return false;
    return true;
  });
  kept.sort((a, b) => {
    const date = (stringField(b, "race_meeting_date") ?? "").localeCompare(stringField(a, "race_meeting_date") ?? "");
    if (date !== 0) return date;
    return (numberField(b, "race_number") ?? 0) - (numberField(a, "race_number") ?? 0);
  });
  return kept.slice(0, PAST_RUN_LIMIT);
}

const SCRATCHED = new Set(["出走取消", "発走除外", "競走除外"]);
const YEAR_IN_NAME = /[(（]\s*(\d{4})\s*[)）]\s*$/;

export function birthYearFromDate(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{4})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  return year;
}

/** 「マイネルエンペラー (2020)」の生年。全角括弧も受ける。 */
export function yearInQualifiedName(name: string): number | null {
  const match = YEAR_IN_NAME.exec(name.trim());
  if (!match) return null;
  return Number(match[1]);
}

/** 生年が一致する候補がちょうど 1 件のときだけ、その名前を返す。出走数では選ばない。 */
export function pickQualifiedName(candidates: Array<{ name: string }>, birthYear: number | null): string | null {
  if (birthYear == null) return null;
  const matches = candidates.filter((candidate) => yearInQualifiedName(candidate.name) === birthYear);
  if (matches.length !== 1) return null;
  return matches[0]!.name;
}

export function entryFacts(entry: Record<string, unknown>): EntryFacts {
  const birthDate = stringField(entry, "birth_date");
  return {
    birthDate,
    birthYear: birthYearFromDate(birthDate),
    careerStarts: numberField(entry, "career_starts"),
    prevOfficialResult: numberField(entry, "prev_official_result"),
    prevDistance: numberField(entry, "prev_distance"),
    prevSurface: stringField(entry, "prev_surface"),
    daysSinceLastRace: numberField(entry, "days_since_last_race"),
    weightToCarryKg: numberField(entry, "weight_to_carry_kg"),
  };
}

export function sameNameUnavailableNote(facts: EntryFacts | undefined): string {
  const starts = facts?.careerStarts == null ? "—" : trimNumber(facts.careerStarts);
  const place = facts?.prevOfficialResult == null ? "—" : `${trimNumber(facts.prevOfficialResult)}着`;
  const distance = facts?.prevDistance == null ? "—" : `${trimNumber(facts.prevDistance)}m`;
  const surface = facts?.prevSurface ?? "—";
  const gap = facts?.daysSinceLastRace == null ? "—" : `${trimNumber(facts.daysSinceLastRace)}日`;
  return `同名馬のため近走取得不可（通算出走数 ${starts}、前走着順 ${place}、前走距離 ${distance}、前走馬場 ${surface}、間隔 ${gap}）`;
}

export type FormFetchPlan =
  | { kind: "done"; task: FormTask }
  | { kind: "requery"; args: Record<string, unknown>; qualifiedName: string; candidates: NameCandidate[] };

/**
 * 馬名だけの近走応答を読む。曖昧で生年が 1 候補に決まるときだけ引き直しを返す。
 * 決まらないときは近走を空にせず、同名である旨を note に残して done にする。
 */
export function planFormFetch(task: FormTask, payload: unknown, race: RaceRef): FormFetchPlan {
  const unresolved = readNameResolutions(payload).filter((entry) => entry.unresolved);
  const horse = unresolved.find((entry) => entry.field === "horse_name" || entry.field == null);
  if (horse) {
    const qualified = pickQualifiedName(horse.candidates, task.facts?.birthYear ?? null);
    if (qualified) {
      return {
        kind: "requery",
        args: withHorseName(task.args, qualified),
        qualifiedName: qualified,
        candidates: horse.candidates,
      };
    }
    return { kind: "done", task: unresolvedTask(task, horse.candidates) };
  }
  if (unresolved.length > 0) {
    return { kind: "done", task: unresolvedTask(task, unresolved.flatMap((entry) => entry.candidates)) };
  }
  return { kind: "done", task: finishedTask(task, payload, race, "unique", resolvedNameOf(payload, task.horseName), []) };
}

/** 生年付きの再取得。まだ曖昧なら同名の注記にして、3 回目は呼ばない。 */
export function finishQualifiedFetch(
  task: FormTask,
  payload: unknown,
  race: RaceRef,
  qualifiedName: string,
  candidates: NameCandidate[],
): FormTask {
  const unresolved = readNameResolutions(payload).filter((entry) => entry.unresolved);
  if (unresolved.length > 0) return unresolvedTask(task, candidates.length > 0 ? candidates : unresolved.flatMap((entry) => entry.candidates));
  return finishedTask(task, payload, race, "resolved_by_birth_year", qualifiedName, candidates);
}

export function horseFormSnapshots(entries: Record<string, unknown>[], tasks: FormTask[]): HorseFormSnapshot[] {
  const forms = new Map(tasks.map((task) => [task.horseName, task]));
  const horses = [...entries].sort((a, b) => (numberField(a, "horse_number") ?? 99) - (numberField(b, "horse_number") ?? 99));
  return horses.map((entry) => {
    const name = stringField(entry, "horse_name") ?? "馬名不明";
    const task = forms.get(name);
    const abnormality = stringField(entry, "race_abnormality");
    const facts = task?.facts ?? entryFacts(entry);
    let resolutionStatus: HorseFormSnapshot["resolutionStatus"] = "missing";
    if (abnormality && SCRATCHED.has(abnormality) && !task) resolutionStatus = "scratched";
    else if (task?.resolution) resolutionStatus = task.resolution.status;
    else if (task?.status === "pending") resolutionStatus = "pending";
    else if (task) resolutionStatus = "unique";
    const rows = task?.rows ?? [];
    return {
      horseName: name,
      horseNumber: numberField(entry, "horse_number"),
      resolvedName: task?.resolution?.resolvedName ?? (resolutionStatus === "unique" ? name : null),
      resolutionStatus,
      pastRunCount: rows.length,
      birthDate: facts.birthDate,
      careerStarts: facts.careerStarts,
      prevOfficialResult: facts.prevOfficialResult,
      prevDistance: facts.prevDistance,
      prevSurface: facts.prevSurface,
      daysSinceLastRace: facts.daysSinceLastRace,
      weightToCarryKg: facts.weightToCarryKg,
      pastRuns: rows.map((row) => ({
        raceName: stringField(row, "race_name_main"),
        date: stringField(row, "race_meeting_date"),
        officialResult: numberField(row, "official_result"),
        surface: stringField(row, "surface"),
        distance: numberField(row, "distance"),
      })),
    };
  });
}

function unresolvedTask(task: FormTask, candidates: NameCandidate[]): FormTask {
  return {
    ...task,
    status: "done",
    rows: [],
    note: sameNameUnavailableNote(task.facts),
    resolution: {
      status: "unresolved",
      resolvedName: null,
      birthYear: task.facts?.birthYear ?? null,
      candidates,
    },
  };
}

function finishedTask(
  task: FormTask,
  payload: unknown,
  race: RaceRef,
  status: FormResolutionStatus,
  resolvedName: string,
  candidates: NameCandidate[],
): FormTask {
  const truncated = payload && typeof payload === "object" && (payload as { truncated?: unknown }).truncated === true;
  return {
    ...task,
    status: "done",
    rows: selectPastRuns(rowsToObjects(payload), race, task.horseName, resolvedName),
    note: truncated ? "近走の取得が打ち切られました" : undefined,
    resolution: {
      status,
      resolvedName,
      birthYear: task.facts?.birthYear ?? null,
      candidates,
    },
  };
}

function resolvedNameOf(payload: unknown, fallback: string): string {
  const horse = readNameResolutions(payload).find((entry) => entry.field === "horse_name" && !entry.unresolved);
  return horse?.candidates[0]?.name ?? fallback;
}

function withHorseName(args: Record<string, unknown>, horseName: string): Record<string, unknown> {
  const filters = args.filters;
  const next =
    filters && typeof filters === "object" && !Array.isArray(filters)
      ? { ...(filters as Record<string, unknown>), horse_name: horseName }
      : { horse_name: horseName };
  return { ...args, filters: next };
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
