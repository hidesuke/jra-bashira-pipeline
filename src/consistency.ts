import type { HorseFormSnapshot } from "./form";

export interface ConsistencyWarning {
  horseName: string;
  kind: "finish" | "weight";
  message: string;
  raceName?: string;
  claimed: string;
  actual: string;
  /** 予想本文から切り出した一致箇所。人が照合できるように残す。 */
  snippet: string;
}

const MARKS = "◎◯○▲☆△★";
const WIN_WORDS = "勝ち|優勝|勝利|制覇|覇者";

/**
 * 予想本文の着順・今回斤量を、その馬の節の中だけで成績と照合する。
 * 一致しないときだけ警告する。公開は止めない。
 */
export function checkPredictionConsistency(text: string, horses: HorseFormSnapshot[]): ConsistencyWarning[] {
  const normalized = normalizePrediction(text);
  const names = horses.map((horse) => horse.horseName).filter((name) => name.length > 0);
  const aliases = horses.flatMap((horse) => raceAliases(horse));
  const aliasTexts = [...new Set(aliases.map((alias) => alias.alias))];
  const sections = horseSections(normalized, names);
  const warnings: ConsistencyWarning[] = [];
  for (const horse of horses) {
    if (horse.resolutionStatus === "scratched" || !horse.horseName) continue;
    const owned = sections
      .filter((section) => section.horse === horse.horseName)
      .map((section) => section.text)
      .join("\n");
    if (!owned) continue;
    warnings.push(...finishWarnings(owned, horse, aliasTexts));
    const weight = weightWarning(owned, horse);
    if (weight) warnings.push(weight);
  }
  return dedupe(warnings);
}

function finishWarnings(text: string, horse: HorseFormSnapshot, allAliases: string[]): ConsistencyWarning[] {
  const actuals = new Map<string, Set<number>>();
  for (const run of horse.pastRuns) {
    const raceName = normalizePrediction(run.raceName?.trim() ?? "");
    if (raceName.length < 2 || run.officialResult == null) continue;
    const places = actuals.get(raceName) ?? new Set<number>();
    places.add(run.officialResult);
    actuals.set(raceName, places);
  }
  const warnings: ConsistencyWarning[] = [];
  const seen = new Set<string>();
  for (const alias of raceAliases(horse)) {
    const places = actuals.get(alias.raceName);
    if (!places) continue;
    for (const hit of findClaims(text, alias.alias, allAliases)) {
      if (places.has(hit.place)) continue;
      const key = `${alias.raceName}\u0000${hit.place}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const actualText = [...places].map((value) => `${trimNumber(value)}着`).join("・");
      const claimed = `${trimNumber(hit.place)}着`;
      warnings.push({
        horseName: horse.horseName,
        kind: "finish",
        raceName: alias.raceName,
        claimed,
        actual: actualText,
        snippet: hit.snippet,
        message: `${horse.horseName}の${alias.raceName}は${actualText}だが、予想本文は${claimed}と書いている: 「${hit.snippet}」`,
      });
    }
  }
  return warnings;
}

function weightWarning(text: string, horse: HorseFormSnapshot): ConsistencyWarning | null {
  const actual = horse.weightToCarryKg;
  if (actual == null) return null;
  const pattern = /今回斤量[^\n]{0,12}?(\d+(?:\.\d+)?)\s*kg/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const claimedValue = Number(match[1]);
    if (!Number.isFinite(claimedValue) || sameWeight(claimedValue, actual)) continue;
    const claimed = `${trimNumber(claimedValue)}kg`;
    const actualText = `${trimNumber(actual)}kg`;
    const snippet = match[0];
    return {
      horseName: horse.horseName,
      kind: "weight",
      claimed,
      actual: actualText,
      snippet,
      message: `${horse.horseName}の今回斤量は${actualText}だが、予想本文は${claimed}と書いている: 「${snippet}」`,
    };
  }
  return null;
}

interface RaceAlias {
  alias: string;
  raceName: string;
}

function raceAliases(horse: HorseFormSnapshot): RaceAlias[] {
  const aliases: RaceAlias[] = [];
  const seen = new Set<string>();
  for (const run of horse.pastRuns) {
    const raceName = normalizePrediction(run.raceName?.trim() ?? "");
    if (raceName.length < 2) continue;
    for (const alias of aliasForms(raceName)) {
      const key = `${alias}\u0000${raceName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push({ alias, raceName });
    }
  }
  return aliases.sort((a, b) => b.alias.length - a.alias.length);
}

function aliasForms(raceName: string): string[] {
  const forms = [raceName];
  if (raceName.endsWith("ステークス")) forms.push(`${raceName.slice(0, -"ステークス".length)}S`);
  return forms;
}

function findClaims(text: string, alias: string, allAliases: string[]): Array<{ place: number; snippet: string }> {
  const claims: Array<{ place: number; snippet: string }> = [];
  for (const index of indexesOf(text, alias)) {
    if (coveredByLongerAlias(text, index, alias, allAliases)) continue;
    const after = text.slice(index + alias.length);
    const sentenceEnd = after.search(/[。\n]/);
    let span = sentenceEnd >= 0 ? after.slice(0, sentenceEnd) : after.slice(0, 40);
    span = span.slice(0, 40);
    const next = nextAliasAt(span, allAliases);
    if (next > 0) span = span.slice(0, next);
    const parsed = parsePlace(span);
    if (!parsed) continue;
    claims.push({ place: parsed.place, snippet: `${alias}${parsed.raw}` });
  }
  return claims;
}

function parsePlace(span: string): { place: number; raw: string } | null {
  const immediate = /^(?:[はでをにのも])?\s*([0-9]+)着/.exec(span);
  if (immediate) return { place: Number(immediate[1]), raw: immediate[0] };
  const win = new RegExp(`^(?:[はでをにのも])?\\s*(${WIN_WORDS})`).exec(span);
  if (win) return { place: 1, raw: win[0] };
  const narrative = /^で[^。\n、]{0,24}?([0-9]+)着/.exec(span);
  if (narrative) return { place: Number(narrative[1]), raw: narrative[0] };
  return null;
}

function coveredByLongerAlias(text: string, index: number, alias: string, allAliases: string[]): boolean {
  for (const other of allAliases) {
    if (other.length <= alias.length || !other.endsWith(alias)) continue;
    const start = index - (other.length - alias.length);
    if (start >= 0 && text.startsWith(other, start)) return true;
  }
  return false;
}

function nextAliasAt(span: string, allAliases: string[]): number {
  let nearest = -1;
  for (const alias of allAliases) {
    if (alias.length < 2) continue;
    const at = span.indexOf(alias);
    if (at <= 0) continue;
    if (nearest < 0 || at < nearest) nearest = at;
  }
  return nearest;
}

function horseSections(text: string, names: string[]): Array<{ horse: string | null; text: string }> {
  const sections: Array<{ horse: string | null; text: string }> = [];
  let horse: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    sections.push({ horse, text: lines.join("\n") });
    lines = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const heading = /^#{1,6}\s/.test(trimmed) || trimmed === "---";
    const next = heading ? null : headerHorse(trimmed, names);
    if (heading || next) {
      flush();
      horse = next;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

function headerHorse(line: string, names: string[]): string | null {
  const stripped = line.replace(/^[-*]\s*/, "").replace(/^#+\s*/, "");
  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^(?:\\d+位\\s+)?(?:[${MARKS}]\\s*)?(?:\\d{1,2}\\s+)?${escaped}(?=$|[\\s（(・はのがを])`);
    if (pattern.test(stripped)) return name;
  }
  return null;
}

export function normalizePrediction(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/Ｓ/g, "S");
}

function indexesOf(text: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
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
