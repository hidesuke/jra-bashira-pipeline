import type { HorseFormSnapshot } from "./form";

export interface ConsistencyWarning {
  horseName: string;
  kind: "finish" | "weight";
  message: string;
  raceName?: string;
  claimed: string;
  actual: string;
}

const OWNER_WINDOW = 80;
const PLACE_WINDOW = 24;

/**
 * 予想本文の「レース名 + N着」と「今回斤量 X kg」を、予想に渡した成績と照合する。
 * 一致しないときだけ警告する。公開は止めない。
 */
export function checkPredictionConsistency(text: string, horses: HorseFormSnapshot[]): ConsistencyWarning[] {
  const names = horses.map((horse) => horse.horseName).filter((name) => name.length > 0);
  const warnings: ConsistencyWarning[] = [];
  for (const horse of horses) {
    if (horse.resolutionStatus === "scratched") continue;
    warnings.push(...finishWarnings(text, horse, names));
    const weight = weightWarning(text, horse, names);
    if (weight) warnings.push(weight);
  }
  return dedupe(warnings);
}

function finishWarnings(text: string, horse: HorseFormSnapshot, names: string[]): ConsistencyWarning[] {
  const byRace = new Map<string, Set<number>>();
  for (const run of horse.pastRuns) {
    const raceName = run.raceName?.trim() ?? "";
    if (raceName.length < 2 || run.officialResult == null) continue;
    const places = byRace.get(raceName) ?? new Set<number>();
    places.add(run.officialResult);
    byRace.set(raceName, places);
  }
  const warnings: ConsistencyWarning[] = [];
  for (const [raceName, actuals] of byRace) {
    const seen = new Set<number>();
    for (const place of claimedPlaces(text, raceName, horse.horseName, names)) {
      if (actuals.has(place) || seen.has(place)) continue;
      seen.add(place);
      const actualText = [...actuals].map((value) => `${trimNumber(value)}着`).join("・");
      const claimed = `${trimNumber(place)}着`;
      warnings.push({
        horseName: horse.horseName,
        kind: "finish",
        raceName,
        claimed,
        actual: actualText,
        message: `${horse.horseName}の${raceName}は${actualText}だが、予想本文は${claimed}と書いている`,
      });
    }
  }
  return warnings;
}

function weightWarning(text: string, horse: HorseFormSnapshot, names: string[]): ConsistencyWarning | null {
  const actual = horse.weightToCarryKg;
  if (actual == null) return null;
  const pattern = /今回斤量[^\n]{0,12}?(\d+(?:\.\d+)?)\s*kg/gi;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = pattern.exec(text)) !== null) {
    if (nearestHorse(text.slice(Math.max(0, match.index - OWNER_WINDOW), match.index), names) !== horse.horseName) continue;
    const claimedValue = Number(match[1]);
    if (!Number.isFinite(claimedValue) || sameWeight(claimedValue, actual)) continue;
    const claimed = `${trimNumber(claimedValue)}kg`;
    if (seen.has(claimed)) continue;
    seen.add(claimed);
    const actualText = `${trimNumber(actual)}kg`;
    return {
      horseName: horse.horseName,
      kind: "weight",
      claimed,
      actual: actualText,
      message: `${horse.horseName}の今回斤量は${actualText}だが、予想本文は${claimed}と書いている`,
    };
  }
  return null;
}

function claimedPlaces(text: string, raceName: string, horseName: string, names: string[]): number[] {
  const places: number[] = [];
  for (const index of indexesOf(text, raceName)) {
    if (nearestHorse(text.slice(Math.max(0, index - OWNER_WINDOW), index), names) !== horseName) continue;
    const place = placeAfter(text, index, raceName);
    if (place != null) places.push(place);
  }
  return places;
}

function placeAfter(text: string, raceIndex: number, raceName: string): number | null {
  const slice = text.slice(raceIndex + raceName.length, raceIndex + raceName.length + PLACE_WINDOW);
  const match = /(\d+)着/.exec(slice);
  if (!match || match.index == null) return null;
  if (slice.slice(0, match.index).includes("\n")) return null;
  const place = Number(match[1]);
  return Number.isFinite(place) ? place : null;
}

function nearestHorse(window: string, names: string[]): string | null {
  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (let index = window.length - 1; index >= 0; index -= 1) {
    for (const name of ordered) {
      if (window.startsWith(name, index)) return name;
    }
  }
  return null;
}

function indexesOf(text: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + needle.length;
  }
  return found;
}

function sameWeight(claimed: number, actual: number): boolean {
  return Math.abs(claimed - actual) < 0.05;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function dedupe(warnings: ConsistencyWarning[]): ConsistencyWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.horseName}\u0000${warning.kind}\u0000${warning.raceName ?? ""}\u0000${warning.claimed}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
