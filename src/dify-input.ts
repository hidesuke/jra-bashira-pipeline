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

/** Dify「[中央競馬]コースの特徴」ユーザー文。入力は競馬場・芝ダート障害・距離だけ。 */
export const COURSE_USER_TOKENS = {
  course: "{{#1788717846587.course#}}",
  type: "{{#1788717846587.type#}}",
  distance: "{{#1788717846587.distance#}}",
} as const;

export function fillCourseUser(template: string, values: { course: string; type: string; distance: string }): string {
  let text = template;
  for (const [key, token] of Object.entries(COURSE_USER_TOKENS)) {
    text = text.split(token).join(values[key as keyof typeof values]);
  }
  if (text.includes("{{#")) {
    throw new JobError("コース特徴のユーザー文に未置換の Dify 変数が残っています", false);
  }
  return text;
}

export interface MergedGoing {
  /** 天気。BASHIRA の weather が baba より優先。 */
  weather: string;
  /** 馬場状態。BASHIRA の track_condition が baba の芝/ダート区分より優先。 */
  condition: string;
  /** クッション値・含水率など baba にしか無い詳細。Dify はこれを備考へ入れていた。 */
  babaDetail: string;
}

/**
 * 馬場の土台は baba（/baba/latest）。同じ項目は BASHIRA get_races で上書きする。
 * クッション値・含水率・使用コース・芝丈は baba のまま残す。
 */
export function mergeGoing(input: { raceRow: Record<string, unknown> | null; baba: unknown; surface: string | null }): MergedGoing {
  const venue = babaVenue(input.baba);
  const bashiraWeather = input.raceRow ? stringField(input.raceRow, "weather") : null;
  const bashiraCondition = input.raceRow ? stringField(input.raceRow, "track_condition") : null;
  const babaWeather = venue ? stringField(venue, "weather") : null;
  const babaCondition = surfaceCondition(venue, input.surface);
  return {
    weather: bashiraWeather ?? babaWeather ?? "不明",
    condition: bashiraCondition ?? babaCondition ?? "不明",
    babaDetail: babaDetail(venue),
  };
}

/** Dify の remarks は「日付 場 レース ｜ 馬場サマリ」。ユーザー備考があればその前に置く。 */
export function composeRemarks(userRemarks: string, detail: string, race: Pick<RaceRef, "date" | "venueCode" | "raceNumber">): string {
  const baba = detail ? `${race.date} 場:${race.venueCode} ${race.raceNumber}R ｜ ${detail}` : "";
  const text = [userRemarks.trim(), baba].filter((part) => part !== "").join("\n");
  return text || "なし";
}

function surfaceCondition(venue: Record<string, unknown> | null, surface: string | null): string | null {
  if (!venue) return null;
  const key = surface === "ダート" ? "dirt" : surface === "芝" ? "turf" : null;
  if (!key) return null;
  const block = venue[key];
  if (!block || typeof block !== "object") return null;
  return stringField(block as Record<string, unknown>, "condition");
}

function babaDetail(venue: Record<string, unknown> | null): string {
  if (!venue) return "";
  const parts: string[] = [];
  const measuredAt = stringField(venue, "measuredAt");
  if (measuredAt) parts.push(`馬場[${measuredAt}]`);
  const cushion = numberField(venue, "cushion");
  if (cushion != null) parts.push(`クッション値${trimNum(cushion)}`);
  const turf = moistureText("芝", venue.turf);
  const dirt = moistureText("ダート", venue.dirt);
  if (turf) parts.push(turf);
  if (dirt) parts.push(dirt);
  const rain = numberField(venue, "rainfallMm");
  if (rain != null) parts.push(`当日雨量${trimNum(rain)}mm`);
  const used = stringField(venue, "usedCourse");
  if (used) parts.push(`使用コース:${used}`);
  const length = stringField(venue, "turfLength");
  if (length) parts.push(length);
  const turfState = stringField(venue, "turfCondition");
  if (turfState) parts.push(`芝の状態:${turfState}`);
  return parts.join(" / ");
}

function moistureText(label: string, block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const row = block as Record<string, unknown>;
  const goal = numberField(row, "goal");
  const corner4 = numberField(row, "corner4");
  const goalCondition = stringField(row, "goalCondition");
  const corner4Condition = stringField(row, "corner4Condition");
  if (goal == null && corner4 == null && !goalCondition && !corner4Condition) return null;
  const bits = [`含水率 ゴール前${goal == null ? "—" : trimNum(goal)} 4角${corner4 == null ? "—" : trimNum(corner4)}`];
  if (goalCondition || corner4Condition) bits.push(`区分 ゴール前${goalCondition ?? "—"} 4角${corner4Condition ?? "—"}`);
  return `${label}:${bits.join(" ")}`;
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function babaVenue(baba: unknown): Record<string, unknown> | null {
  if (!baba || typeof baba !== "object") return null;
  const venue = (baba as { venue?: unknown }).venue;
  if (!venue || typeof venue !== "object") return null;
  return venue as Record<string, unknown>;
}
