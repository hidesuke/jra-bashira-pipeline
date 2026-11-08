import type { McpTool } from "../src/schema";

export function tool(name: string, args: string[], fields: string[], required: string[] = []): McpTool {
  const properties: Record<string, unknown> = {};
  for (const arg of args) properties[arg] = { type: "string" };
  properties.filters = {
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
  };
  properties.columns = { type: "array", items: { type: "string", enum: fields } };
  return { name, inputSchema: { type: "object", required, properties } };
}

const RACE_FIELDS = [
  "race_id",
  "race_status",
  "race_meeting_date",
  "race_track",
  "race_number",
  "race_name_main",
  "grade",
  "race_condition",
  "race_type",
  "surface",
  "distance",
  "track_condition",
  "weather",
  "starters",
  "scheduled_horse_count",
  "rail_type",
  "weight_type",
  "post_time",
  "odds_observed_at",
  "first_3f_sec",
  "last_3f_sec",
];

const ENTRY_FIELDS = [
  "horse_number",
  "horse_name",
  "horse_sex",
  "horse_age",
  "bracket_number",
  "jockey_name",
  "trainer_name",
  "trainer_east_west",
  "weight_to_carry_kg",
  "horse_weight",
  "horse_weight_difference_with_previous_race",
  "sire_name",
  "broodmare_sire_name",
  "win_odds",
  "win_odds_rank",
  "odds_kind",
  "odds_observed_at",
  "race_abnormality",
  "entry_status",
  "birth_date",
  "career_starts",
  "prev_official_result",
  "prev_distance",
  "prev_surface",
  "days_since_last_race",
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
  "scheduled_horse_count",
  "local_overseas_type",
  "dead_heat",
  "is_jockey_change",
];

const STAT_FIELDS = [
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
  "race_meeting_date",
  "is_fastest_last_3f",
  "dimensions",
  "metrics",
  "filters",
  "min_starts",
];

export const bashiraTools: McpTool[] = [
  tool("get_races", ["filters", "columns", "limit"], RACE_FIELDS, ["filters"]),
  tool("get_entries", ["filters", "columns", "limit", "order_by", "order"], ENTRY_FIELDS, ["filters"]),
  tool("get_odds", ["race_id", "bet_type", "limit"], ["race_id", "bet_type"], ["race_id", "bet_type"]),
  tool("get_stats", ["dimensions", "metrics", "filters", "min_starts"], STAT_FIELDS, []),
];

export const notionSchema = {
  properties: {
    名前: { type: "title" },
    日付: { type: "date" },
    競馬場: { type: "select", select: { options: [{ name: "福島" }, { name: "東京" }] } },
    レース: { type: "select", select: { options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].map((name) => ({ name })) } },
    指数分布: { type: "rich_text" },
    自信度: { type: "rich_text" },
    波乱度: { type: "rich_text" },
  },
};
