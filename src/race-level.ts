import { addCalendarDays } from "./jst";
import { numberField, stringField } from "./rows";
import type { KvStore } from "./types";

/**
 * 3歳未勝利の一次予想に足す過去最高レースレベル。
 * 値は共有マシンが APP_KV に書いたものを読むだけ。この Worker は計算も書き込みもしない。
 * プロンプト本文はここに置かない。出す条件は race の system にあるマーカーだけを見る。
 */
export const RACE_LEVEL_META_KEY = "c1:v1:meta";
export const RACE_LEVEL_FEAT_PREFIX = "c1:v1:feat:";
export const RACE_LEVEL_MARKER = "<!-- input:race_level -->";
export const RACE_LEVEL_HEADING = "# 過去最高レースレベル（3歳未勝利のみ）";
export const RACE_LEVEL_UNKNOWN = "過去最高レースレベル 不明";
/** 開催日のこの日数前の基準日までは使う。開催日当日とそれ以降は使わない。 */
export const RACE_LEVEL_ASOF_MAX_AGE_DAYS = 9;

const GRADED = new Set(["G1", "G2", "G3", "L"]);
const SCRATCHED = new Set(["出走取消", "発走除外", "競走除外"]);

export const RACE_LEVEL_REASONS = {
  notApplicable: "not_applicable",
  promptWithoutC1: "prompt_without_c1",
  raceDateUnreadable: "race_date_unreadable",
  metaMissing: "meta_missing",
  metaInvalid: "meta_invalid",
  asofStale: "asof_stale",
  asofNotBeforeRace: "asof_not_before_race",
  featMissing: "feat_missing",
  featInvalid: "feat_invalid",
} as const;

export interface RaceLevelHorse {
  horseNumber: number | null;
  horseName: string;
  /** 生年月日の先頭 10 文字。日付でなければ null。 */
  birthDate: string | null;
  /** `馬名|YYYY-MM-DD`。名前か生年月日が無ければ null。 */
  key: string | null;
  display: string;
  /** 表の display をそのまま使った。 */
  fromTable: boolean;
}

export interface RaceLevelRecord {
  applied: boolean;
  /** 出さなかった理由、または全頭を不明にした理由。問題が無ければ null。 */
  reason: string | null;
  asof: string | null;
  dataThrough: string | null;
  featSha256: string | null;
  horses: RaceLevelHorse[];
  /** 表示が「過去最高レースレベル 不明」の頭数。 */
  missing: number;
}

export interface RaceLevelLoad {
  /** 馬柱の末尾に足す節。出さないときは空。 */
  text: string;
  record: RaceLevelRecord;
  /** raceInputGaps に足す理由。出さないとき、および表に無い馬だけでは空。 */
  gaps: string[];
}

interface ParsedMeta {
  asof: string;
  dataThrough: string;
  featKey: string;
  featSha256: string;
}

/** 対象レースの raceRow だけで判定する。適用外は KV を読まない。 */
export function raceLevelApplies(raceRow: Record<string, unknown> | null): boolean {
  if (!raceRow) return false;
  const type = trimmed(stringField(raceRow, "race_type"));
  const condition = trimmed(stringField(raceRow, "race_condition"));
  const grade = trimmed(stringField(raceRow, "grade"));
  const surface = trimmed(stringField(raceRow, "surface"));
  const maiden = condition === "未勝利";
  const openClass = condition === "オープン";
  const flat = surface === "芝" || surface === "ダート";
  return type === "3歳" && maiden && !openClass && !GRADED.has(grade) && flat;
}

export async function loadRaceLevel(
  kv: KvStore,
  raceRow: Record<string, unknown> | null,
  entries: Record<string, unknown>[],
  raceDate: string,
  raceSystemPrompt: string,
): Promise<RaceLevelLoad> {
  if (!raceLevelApplies(raceRow)) {
    return done({ applied: false, reason: RACE_LEVEL_REASONS.notApplicable });
  }
  if (!raceSystemPrompt.includes(RACE_LEVEL_MARKER)) {
    return done({ applied: false, reason: RACE_LEVEL_REASONS.promptWithoutC1 });
  }
  const meeting = calendarDay(raceDate);
  if (!meeting) {
    return done({
      applied: true,
      reason: RACE_LEVEL_REASONS.raceDateUnreadable,
      horses: unknownHorses(entries),
      gaps: ["過去最高レースレベル（開催日を読めない）"],
    });
  }
  const metaRead = await readJson(kv, RACE_LEVEL_META_KEY);
  if (metaRead.status === "missing") {
    return unknownAll(entries, RACE_LEVEL_REASONS.metaMissing, ["過去最高レースレベル（c1:v1:meta が無い）"]);
  }
  const meta = metaRead.status === "ok" ? parseMeta(metaRead.value) : null;
  if (!meta) {
    return unknownAll(entries, RACE_LEVEL_REASONS.metaInvalid, ["過去最高レースレベル（c1:v1:meta を読めない）"]);
  }
  const oldest = addCalendarDays(meeting, -RACE_LEVEL_ASOF_MAX_AGE_DAYS);
  if (meta.asof < oldest) {
    return unknownAll(
      entries,
      RACE_LEVEL_REASONS.asofStale,
      [`過去最高レースレベル（基準日 ${meta.asof} が開催日の9日前より古い）`],
      meta,
    );
  }
  if (meta.asof >= meeting) {
    return unknownAll(
      entries,
      RACE_LEVEL_REASONS.asofNotBeforeRace,
      [`過去最高レースレベル（基準日 ${meta.asof} が開催日以降）`],
      meta,
    );
  }
  const featRead = await readJson(kv, meta.featKey);
  if (featRead.status === "missing") {
    return unknownAll(entries, RACE_LEVEL_REASONS.featMissing, [`過去最高レースレベル（${meta.featKey} が無い）`], meta);
  }
  const table = featRead.status === "ok" ? parseFeat(featRead.value, meta.asof) : null;
  if (!table) {
    return unknownAll(entries, RACE_LEVEL_REASONS.featInvalid, [`過去最高レースレベル（${meta.featKey} を読めない）`], meta);
  }
  const horses = listedHorses(entries, table.displays);
  const gaps = table.unsafe ? ["過去最高レースレベル（表示に差し込み記号がある馬がある）"] : [];
  return done({
    applied: true,
    reason: null,
    asof: meta.asof,
    dataThrough: meta.dataThrough,
    featSha256: meta.featSha256,
    horses,
    gaps,
  });
}

export function isRaceLevelRecord(value: unknown): value is RaceLevelRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as RaceLevelRecord;
  if (typeof row.applied !== "boolean") return false;
  if (row.reason !== null && typeof row.reason !== "string") return false;
  if (!nullableString(row.asof) || !nullableString(row.dataThrough) || !nullableString(row.featSha256)) return false;
  if (!Array.isArray(row.horses) || !row.horses.every(isRaceLevelHorse)) return false;
  return typeof row.missing === "number" && Number.isInteger(row.missing) && row.missing >= 0;
}

function done(input: {
  applied: boolean;
  reason: string | null;
  asof?: string | null;
  dataThrough?: string | null;
  featSha256?: string | null;
  horses?: RaceLevelHorse[];
  gaps?: string[];
}): RaceLevelLoad {
  const horses = input.applied ? (input.horses ?? []) : [];
  const record: RaceLevelRecord = {
    applied: input.applied,
    reason: input.reason,
    asof: input.asof ?? null,
    dataThrough: input.dataThrough ?? null,
    featSha256: input.featSha256 ?? null,
    horses,
    missing: horses.filter((horse) => horse.display === RACE_LEVEL_UNKNOWN).length,
  };
  return {
    text: input.applied ? renderSection(horses, record.dataThrough) : "",
    record,
    gaps: input.gaps ?? [],
  };
}

function unknownAll(
  entries: Record<string, unknown>[],
  reason: string,
  gaps: string[],
  meta?: ParsedMeta,
): RaceLevelLoad {
  return done({
    applied: true,
    reason,
    asof: meta?.asof ?? null,
    dataThrough: meta?.dataThrough ?? null,
    featSha256: meta?.featSha256 ?? null,
    horses: unknownHorses(entries),
    gaps,
  });
}

function renderSection(horses: RaceLevelHorse[], dataThrough: string | null): string {
  const lines = horses.map((horse) => {
    const number = horse.horseNumber == null ? "?" : String(horse.horseNumber);
    return `${number} ${horse.horseName}: ${horse.display}`;
  });
  const basis = dataThrough ? `（基準: 確定データ ${dataThrough} まで）` : "（基準: 確定データ 不明）";
  return [RACE_LEVEL_HEADING, ...lines, basis].join("\n");
}

function unknownHorses(entries: Record<string, unknown>[]): RaceLevelHorse[] {
  return listedHorses(entries, {});
}

function listedHorses(entries: Record<string, unknown>[], table: Record<string, string>): RaceLevelHorse[] {
  return activeEntries(entries).map((entry) => {
    const identity = horseIdentity(entry);
    const stored = identity.key == null ? undefined : table[identity.key];
    const fromTable = typeof stored === "string";
    return {
      ...identity,
      display: fromTable ? stored : RACE_LEVEL_UNKNOWN,
      fromTable,
    };
  });
}

function activeEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...entries]
    .filter((entry) => !SCRATCHED.has(trimmed(stringField(entry, "race_abnormality"))))
    .sort((a, b) => (numberField(a, "horse_number") ?? 99) - (numberField(b, "horse_number") ?? 99));
}

function horseIdentity(entry: Record<string, unknown>): Omit<RaceLevelHorse, "display" | "fromTable"> {
  const horseNumber = numberField(entry, "horse_number");
  const name = trimmed(stringField(entry, "horse_name"));
  const birthDate = birthDay(entry);
  return {
    horseNumber,
    horseName: name || "馬名不明",
    birthDate,
    key: name && birthDate ? `${name}|${birthDate}` : null,
  };
}

function birthDay(entry: Record<string, unknown>): string | null {
  const raw = stringField(entry, "birth_date");
  if (!raw) return null;
  const day = raw.trim().slice(0, 10);
  return calendarDay(day);
}

function parseMeta(value: unknown): ParsedMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const asof = calendarDay(row.asof);
  const dataThrough = calendarDay(row.data_through);
  const featKey = typeof row.feat_key === "string" ? row.feat_key : "";
  const featSha256 = typeof row.feat_sha256 === "string" ? row.feat_sha256 : "";
  if (!asof || !dataThrough) return null;
  if (featKey !== `${RACE_LEVEL_FEAT_PREFIX}${asof}`) return null;
  if (!/^[0-9a-f]{64}$/i.test(featSha256)) return null;
  return { asof, dataThrough, featKey, featSha256 };
}

/** display が差し込み記号を含む馬は表に載せない。ジョブを止めないため、その馬は不明にする。 */
function parseFeat(value: unknown, asof: string): { displays: Record<string, string>; unsafe: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (calendarDay(row.asof) !== asof) return null;
  if (!row.horses || typeof row.horses !== "object" || Array.isArray(row.horses)) return null;
  const displays: Record<string, string> = {};
  let unsafe = false;
  for (const [key, entry] of Object.entries(row.horses as Record<string, unknown>)) {
    const display = displayOf(entry);
    if (display == null) continue;
    if (display.includes("{{")) {
      unsafe = true;
      continue;
    }
    displays[key] = display;
  }
  return { displays, unsafe };
}

function displayOf(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const display = (entry as { display?: unknown }).display;
  if (typeof display !== "string" || display.trim() === "") return null;
  return display;
}

async function readJson(kv: KvStore, key: string): Promise<{ status: "missing" | "invalid" | "ok"; value?: unknown }> {
  const raw = await kv.get(key);
  if (raw == null || raw.trim() === "") return { status: "missing" };
  try {
    return { status: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    return { status: "invalid" };
  }
}

function calendarDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try {
    return addCalendarDays(value, 0) === value ? value : null;
  } catch {
    return null;
  }
}

function trimmed(value: string | null): string {
  return value?.trim() ?? "";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isRaceLevelHorse(value: unknown): value is RaceLevelHorse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as RaceLevelHorse;
  if (row.horseNumber !== null && (typeof row.horseNumber !== "number" || !Number.isFinite(row.horseNumber))) return false;
  if (typeof row.horseName !== "string" || row.horseName === "") return false;
  if (!nullableString(row.birthDate) || !nullableString(row.key)) return false;
  return typeof row.display === "string" && typeof row.fromTable === "boolean";
}
