import { JobError, type RaceRef } from "./types";
import { numberField, stringField } from "./rows";

/** レース予想ユーザー文の差し込み。KV はこちらの名前を使う。 */
export const RACE_USER_PLACEHOLDERS = {
  umabashira: "{{umabashira}}",
  course_analysis: "{{course_analysis}}",
  weather: "{{weather}}",
  condition: "{{condition}}",
  remarks: "{{remarks}}",
} as const;

/**
 * 移行期間の Dify ノード ID。KV を上の名前へ替えるまで、同じ値で置換する。
 * 天気は DSL の綴り weathre のまま。
 */
export const RACE_USER_DIFY_TOKENS = {
  umabashira: "{{#1788721223615.output#}}",
  course_analysis: "{{#1788721380442.output#}}",
  weather: "{{#1788103991048.weathre#}}",
  condition: "{{#1788103991048.condition#}}",
  remarks: "{{#1787386477043.remarks#}}",
} as const;

export function fillRaceUser(
  template: string,
  values: { umabashira: string; course_analysis: string; weather: string; condition: string; remarks: string },
): string {
  return fillPlaceholders(
    template,
    RACE_USER_PLACEHOLDERS,
    RACE_USER_DIFY_TOKENS,
    values,
    "レース予想のユーザー文に未置換の差し込み（{{）が残っています",
  );
}

/** コース特徴ユーザー文。競馬場・芝/ダート/障害・距離と、コードで計算したコースデータ要約。 */
export const COURSE_USER_PLACEHOLDERS = {
  venue: "{{venue}}",
  surface: "{{surface}}",
  distance: "{{distance}}",
  course_summary: "{{course_summary}}",
} as const;

/** 移行期間の Dify ノード ID。course は競馬場、type は馬場種類。 */
export const COURSE_USER_DIFY_TOKENS = {
  venue: "{{#1788717846587.course#}}",
  surface: "{{#1788717846587.type#}}",
  distance: "{{#1788717846587.distance#}}",
} as const;

export function fillCourseUser(
  template: string,
  values: { venue: string; surface: string; distance: string; course_summary: string },
): string {
  return fillPlaceholders(
    template,
    COURSE_USER_PLACEHOLDERS,
    COURSE_USER_DIFY_TOKENS,
    values,
    "コース特徴のユーザー文に未置換の差し込み（{{）が残っています",
  );
}

function fillPlaceholders(
  template: string,
  placeholders: Readonly<Record<string, string>>,
  legacy: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
  message: string,
): string {
  const pairs: Array<{ token: string; value: string }> = [];
  for (const key of Object.keys(placeholders)) {
    const value = values[key];
    if (typeof value !== "string") throw new JobError(message, false);
    pairs.push({ token: placeholders[key]!, value });
    const old = legacy[key];
    if (old !== undefined) pairs.push({ token: old, value });
  }
  const ordered = pairs.sort((a, b) => b.token.length - a.token.length);
  const pattern = new RegExp(ordered.map((item) => item.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const byToken = new Map(ordered.map((item) => [item.token, item.value]));
  const text = template.replace(pattern, (token) => byToken.get(token) ?? token);
  if (text.includes("{{")) throw new JobError(message, false);
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
