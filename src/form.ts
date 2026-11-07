import { assertFields, assertToolArgs, type ToolCatalog } from "./schema";
import type { RaceRef } from "./types";
import { numberField, stringField } from "./rows";

/** 近走は新しい順に最大 10 走。今回のレース行を落とす余裕を見て 12 行取る。 */
export const PAST_RUN_LIMIT = 10;
export const PAST_QUERY_LIMIT = 12;
export const FORM_BATCH_SIZE = 8;

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

export interface FormTask {
  horseName: string;
  horseNumber: number | null;
  status: "pending" | "done";
  args: Record<string, unknown>;
  rows: Record<string, unknown>[];
  note?: string;
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
    });
  }
  return tasks;
}

/** 今回のレースと、まだ走っていない行を除き、新しい順に最大 10 走。 */
export function selectPastRuns(
  rows: Record<string, unknown>[],
  race: RaceRef,
  horseName: string,
): Record<string, unknown>[] {
  const kept = rows.filter((row) => {
    const name = stringField(row, "horse_name");
    if (name && name !== horseName) return false;
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
