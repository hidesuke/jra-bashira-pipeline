import { BASHIRA_MARKER, type RaceRef } from "./types";
import type { OddsSummary } from "./odds";
import { paragraphBlocks } from "./notion";

export interface PageBodyInput {
  race: RaceRef;
  raceName: string | null;
  requestedBy: string;
  odds: OddsSummary;
  courseModel: string;
  raceModel: string;
  courseModelVersion: string | null;
  raceModelVersion: string | null;
  coursePromptVersion: string;
  racePromptVersion: string;
  印: string;
  予想本文: string;
  courseText: string;
}

export function pageTitle(race: RaceRef, raceName: string | null): string {
  const base = raceName?.trim() || `${race.venue}${race.raceNumber}R`;
  return `【BASHIRA】${base}`;
}

export function pageLines(input: PageBodyInput): string[] {
  const oddsReason = input.odds.available ? "あり" : `なし（${input.odds.reason ?? "理由不明"}）`;
  const horseLines = input.odds.horses
    .filter((horse) => horse.odds != null || horse.oddsMin != null)
    .map((horse) => {
      const number = horse.horseNumber ?? horse.selection ?? "?";
      const price = horse.odds ?? `${horse.oddsMin ?? "-"}〜${horse.oddsMax ?? "-"}`;
      return `${number}: ${price}`;
    });
  return [
    BASHIRA_MARKER,
    `${input.race.date} ${input.race.venue} ${input.race.raceNumber}R ${input.raceName ?? ""}`.trim(),
    `実行者: ${input.requestedBy}`,
    "course_variant: null（内・外コースのデータは無い）",
    `オッズ種別: ${input.odds.kind ?? "なし"}`,
    `オッズ観測時刻（JST）: ${input.odds.observedAtJst ?? "なし"}`,
    `オッズ: ${oddsReason}`,
    input.odds.detail ? `オッズ詳細: ${input.odds.detail}` : "",
    `指定モデル（course）: ${input.courseModel}`,
    `指定モデル（race）: ${input.raceModel}`,
    `応答モデル modelVersion（course）: ${input.courseModelVersion ?? "応答に modelVersion が無い"}`,
    `応答モデル modelVersion（race）: ${input.raceModelVersion ?? "応答に modelVersion が無い"}`,
    `プロンプト版（course）: ${input.coursePromptVersion}`,
    `プロンプト版（race）: ${input.racePromptVersion}`,
    "印",
    input.印,
    "予想",
    input.予想本文,
    horseLines.length > 0 ? `単勝オッズ\n${horseLines.join("\n")}` : "",
    "コース分析",
    clipAnalysis(input.courseText),
  ].filter((line) => line !== "");
}

export function pageBlocks(input: PageBodyInput): Array<Record<string, unknown>> {
  return paragraphBlocks(pageLines(input));
}

function clipAnalysis(text: string): string {
  const chars = [...text];
  if (chars.length <= 8000) return text;
  return `${chars.slice(0, 8000).join("")}\n…（コース分析を省略）`;
}
