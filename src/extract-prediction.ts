import type { RacePredictionFields } from "./gemini";
import { parseRacePrediction } from "./gemini";
import { JobError } from "./types";

const STATUSES = ["1強・独走型", "2強・一騎打ち型", "3〜4頭・上位拮抗型", "なだらか・二極化型", "単穴潜伏・伏兵型", "超混戦・ドングリ型"];

/** Dify のパラメータ抽出と同じ項目を、指定された Markdown 見出しから取る。取れなければ JSON も試す。 */
export function readRacePrediction(text: string): RacePredictionFields {
  try {
    return extractRaceMarkdown(text);
  } catch (err) {
    if (!(err instanceof JobError)) throw err;
    try {
      return parseRacePrediction(text);
    } catch {
      throw err;
    }
  }
}

export function extractRaceMarkdown(text: string): RacePredictionFields {
  const body = text.trim();
  const statusLine = lineOf(body, "指数分布ステータス");
  const 指数分布 = STATUSES.find((status) => statusLine?.includes(status)) ?? null;
  const confidenceLine = lineOf(body, "予想自信度");
  const 自信度 = confidenceLine?.match(/【\s*([ABC])\s*】/)?.[1] ?? null;
  const turbulenceLine = lineOf(body, "波乱度");
  const 波乱度 = turbulenceLine?.match(/【\s*(堅実|中波乱|大波乱)\s*】/)?.[1] ?? null;
  const 印 = sectionOf(body, "競馬新聞風印予想");
  if (!指数分布 || !自信度 || !波乱度 || !印) {
    throw new JobError("予想本文から指数分布・自信度・波乱度・印を読み取れませんでした", true);
  }
  return { 指数分布, 自信度, 波乱度, 印, 予想本文: body };
}

function lineOf(text: string, label: string): string | null {
  const match = text.match(new RegExp(`${label}[^\\n]*`));
  return match?.[0] ?? null;
}

function sectionOf(text: string, heading: string): string | null {
  const start = text.indexOf(heading);
  if (start < 0) return null;
  const after = text.slice(start + heading.length).replace(/^\s*/, "");
  const next = after.search(/\n###\s/);
  const body = (next >= 0 ? after.slice(0, next) : after).trim();
  return body || null;
}
