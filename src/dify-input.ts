import { JobError, type RaceRef } from "./types";
import { numberField, stringField } from "./rows";

/** Dify「予測」ユーザー文の変数。ノード ID は DSL のまま。 */
export const RACE_USER_TOKENS = {
  umabashira: "{{#1788721223615.output#}}",
  course: "{{#1788721380442.output#}}",
  weather: "{{#1788103991048.weathre#}}",
  condition: "{{#1788103991048.condition#}}",
  remarks: "{{#1787386477043.remarks#}}",
} as const;

export function fillRaceUser(
  template: string,
  values: { umabashira: string; course: string; weather: string; condition: string; remarks: string },
): string {
  let text = template;
  for (const [key, token] of Object.entries(RACE_USER_TOKENS)) {
    text = text.split(token).join(values[key as keyof typeof values]);
  }
  if (text.includes("{{#")) {
    throw new JobError("レース予想のユーザー文に未置換の Dify 変数が残っています", false);
  }
  return text;
}

/** Dify のコース特徴ワークフローへ渡るレース基本情報だけ。集計は入れない。 */
export function courseUserMessage(input: { race: RaceRef; raceRow: Record<string, unknown> | null; baba: unknown }): string {
  const row = input.raceRow;
  const surface = row ? stringField(row, "surface") : null;
  const distance = row ? numberField(row, "distance") : null;
  const lines = [
    "コースの特徴を書くためのレース条件です。",
    "",
    `- 日付: ${input.race.date}`,
    `- 開催場: ${input.race.venue}`,
    `- レース番号: ${input.race.raceNumber}`,
    `- レース名: ${row ? stringField(row, "race_name_main") ?? "なし" : "なし"}`,
    `- グレード: ${row ? stringField(row, "grade") ?? "なし" : "なし"}`,
    `- 馬場: ${surface ?? "不明"}`,
    `- 距離: ${distance == null ? "不明" : distance}`,
    `- コース替わり: ${row ? stringField(row, "rail_type") ?? "不明" : "不明"}`,
    `- 天気: ${weatherOf(row, input.baba)}`,
    `- 馬場状態: ${conditionOf(row, input.baba, surface)}`,
  ];
  return lines.join("\n");
}

export function weatherOf(row: Record<string, unknown> | null, baba: unknown): string {
  return (row ? stringField(row, "weather") : null) ?? stringFromBaba(baba, "weather") ?? "不明";
}

export function conditionOf(row: Record<string, unknown> | null, baba: unknown, surface: string | null): string {
  return (row ? stringField(row, "track_condition") : null) ?? babaCondition(baba, surface) ?? "不明";
}

function babaCondition(baba: unknown, surface: string | null): string | null {
  const venue = babaVenue(baba);
  if (!venue) return null;
  const key = surface === "ダート" ? "dirt" : surface === "障害" ? "jump" : "turf";
  const block = venue[key];
  if (!block || typeof block !== "object") return null;
  const condition = (block as { condition?: unknown }).condition;
  return typeof condition === "string" && condition.trim() !== "" ? condition : null;
}

function stringFromBaba(baba: unknown, key: string): string | null {
  const venue = babaVenue(baba);
  if (!venue) return null;
  const value = venue[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function babaVenue(baba: unknown): Record<string, unknown> | null {
  if (!baba || typeof baba !== "object") return null;
  const venue = (baba as { venue?: unknown }).venue;
  if (!venue || typeof venue !== "object") return null;
  return venue as Record<string, unknown>;
}
