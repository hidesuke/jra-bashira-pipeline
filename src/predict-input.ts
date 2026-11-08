import type { HorseFormSnapshot } from "./form";
import { keys, kvGetJson } from "./kv";
import type { KvStore } from "./types";

/**
 * Workers KV の値は 25MiB まで。
 * 読み返しを軽くするため 10 万文字で分割し、馬柱とレース入力はそれぞれ 50 万文字で切る。
 */
export const PREDICT_INPUT_CHUNK_CHARS = 100_000;
export const PREDICT_INPUT_MAX_CHARS = 500_000;
const TRUNCATION_MARK = "\n…（KV の保存上限に合わせて切り詰め）";

/** コース分析の末尾から読み、コース成績に使った関連コース。プロンプト文は入れない。 */
export interface StoredRelatedCourses {
  status: "absent" | "ok" | "unclosed" | "malformed";
  /** status が ok のとき、実際に数えた一覧。それ以外は空。 */
  courses: Array<{ track: string; surface: string; distance: number }>;
  /** 5 件を超えて捨てた行数。 */
  dropped: number;
  /** コース成績に書いた「関連コース:」の行。原文。 */
  line: string;
}

export type StoredSectionState = "stored" | "absent" | "incomplete";

export interface PredictInputRecord {
  raceKey: string;
  runId: string;
  umabashira: string;
  raceInput: string;
  horses: HorseFormSnapshot[];
  truncated: boolean;
  incomplete: boolean;
  /** ユーザー文の分割が欠けている。近10走の抽出には使わない。 */
  raceInputIncomplete: boolean;
  /** 入力スナップショットを書いた時刻。この変更より前の保存は null。 */
  savedAt: string | null;
  /** 別フィールドが無い古い保存は null。state が absent。 */
  pastRuns: string | null;
  courseRecords: string | null;
  /** 別フィールドが無い保存は null。state が absent。 */
  runnerStats: string | null;
  relatedCourses: StoredRelatedCourses | null;
  pastRunsState: StoredSectionState;
  courseRecordsState: StoredSectionState;
  runnerStatsState: StoredSectionState;
}

interface StoredMeta {
  v: 1;
  runId: string;
  truncated: boolean;
  umabashiraBytes: number;
  raceInputBytes: number;
  horses: HorseFormSnapshot[];
  savedAt?: string;
  umabashira?: string;
  raceInput?: string;
  pastRuns?: string;
  courseRecords?: string;
  runnerStats?: string;
  relatedCourses?: StoredRelatedCourses;
  umabashiraChunks?: number;
  raceInputChunks?: number;
  pastRunsChunks?: number;
  courseRecordsChunks?: number;
  runnerStatsChunks?: number;
}

type ChunkPart = "u" | "r" | "p" | "c" | "s";

export async function savePredictInput(
  kv: KvStore,
  input: {
    raceKey: string;
    runId: string;
    umabashira: string;
    raceInput: string;
    horses: HorseFormSnapshot[];
    /** この入力を書いた時刻。ISO 8601。 */
    savedAt?: string;
    /** 一次予想に渡した近10走。プロンプト文は入れない。 */
    pastRuns?: string;
    /** 一次予想に渡したコース成績。プロンプト文は入れない。 */
    courseRecords?: string;
    /** 一次予想に渡した父・母の父・騎手のコース成績。プロンプト文は入れない。 */
    runnerStats?: string;
    relatedCourses?: StoredRelatedCourses;
  },
): Promise<{ truncated: boolean; umabashiraBytes: number; raceInputBytes: number }> {
  const umabashira = clip(input.umabashira);
  const raceInput = clip(input.raceInput);
  const pastRuns = input.pastRuns == null ? null : clip(input.pastRuns);
  const courseRecords = input.courseRecords == null ? null : clip(input.courseRecords);
  const runnerStats = input.runnerStats == null ? null : clip(input.runnerStats);
  const truncated =
    umabashira.truncated || raceInput.truncated || Boolean(pastRuns?.truncated) || Boolean(courseRecords?.truncated) || Boolean(runnerStats?.truncated);
  const horses = input.horses;
  const relatedCourses = isStoredRelatedCourses(input.relatedCourses) ? input.relatedCourses : undefined;
  await deleteChunks(kv, input.raceKey);
  const meta: StoredMeta = {
    v: 1,
    runId: input.runId,
    truncated,
    umabashiraBytes: utf8Bytes(umabashira.text),
    raceInputBytes: utf8Bytes(raceInput.text),
    horses,
  };
  const savedAt = input.savedAt?.trim() ?? "";
  if (savedAt) meta.savedAt = savedAt;
  if (relatedCourses) meta.relatedCourses = relatedCourses;
  const inlinePayload: Record<string, unknown> = {
    umabashira: umabashira.text,
    raceInput: raceInput.text,
    horses,
  };
  if (pastRuns) inlinePayload.pastRuns = pastRuns.text;
  if (courseRecords) inlinePayload.courseRecords = courseRecords.text;
  if (runnerStats) inlinePayload.runnerStats = runnerStats.text;
  if (relatedCourses) inlinePayload.relatedCourses = relatedCourses;
  if (JSON.stringify(inlinePayload).length <= PREDICT_INPUT_CHUNK_CHARS) {
    meta.umabashira = umabashira.text;
    meta.raceInput = raceInput.text;
    if (pastRuns) meta.pastRuns = pastRuns.text;
    if (courseRecords) meta.courseRecords = courseRecords.text;
    if (runnerStats) meta.runnerStats = runnerStats.text;
  } else {
    await putChunks(kv, input.raceKey, meta, "u", "umabashiraChunks", umabashira.text);
    await putChunks(kv, input.raceKey, meta, "r", "raceInputChunks", raceInput.text);
    if (pastRuns) await putChunks(kv, input.raceKey, meta, "p", "pastRunsChunks", pastRuns.text);
    if (courseRecords) await putChunks(kv, input.raceKey, meta, "c", "courseRecordsChunks", courseRecords.text);
    if (runnerStats) await putChunks(kv, input.raceKey, meta, "s", "runnerStatsChunks", runnerStats.text);
  }
  await kv.put(keys.predictInput(input.raceKey), JSON.stringify(meta));
  return { truncated, umabashiraBytes: meta.umabashiraBytes, raceInputBytes: meta.raceInputBytes };
}

export async function loadPredictInput(kv: KvStore, raceKey: string): Promise<PredictInputRecord | null> {
  const meta = await kvGetJson<StoredMeta>(kv, keys.predictInput(raceKey));
  if (!meta || meta.v !== 1) return null;
  const umabashira = await readText(kv, raceKey, "u", meta.umabashira, meta.umabashiraChunks);
  const raceInput = await readText(kv, raceKey, "r", meta.raceInput, meta.raceInputChunks);
  const pastRuns = await readText(kv, raceKey, "p", meta.pastRuns, meta.pastRunsChunks);
  const courseRecords = await readText(kv, raceKey, "c", meta.courseRecords, meta.courseRecordsChunks);
  const runnerStats = await readText(kv, raceKey, "s", meta.runnerStats, meta.runnerStatsChunks);
  const pastRunsState = sectionState(meta.pastRuns, meta.pastRunsChunks, pastRuns.incomplete);
  const courseRecordsState = sectionState(meta.courseRecords, meta.courseRecordsChunks, courseRecords.incomplete);
  const runnerStatsState = sectionState(meta.runnerStats, meta.runnerStatsChunks, runnerStats.incomplete);
  const savedAt = typeof meta.savedAt === "string" && meta.savedAt.trim() !== "" ? meta.savedAt.trim() : null;
  return {
    raceKey,
    runId: meta.runId,
    umabashira: umabashira.text,
    raceInput: raceInput.text,
    horses: Array.isArray(meta.horses) ? meta.horses : [],
    truncated: Boolean(meta.truncated),
    incomplete: umabashira.incomplete || raceInput.incomplete || pastRuns.incomplete || courseRecords.incomplete || runnerStats.incomplete,
    raceInputIncomplete: raceInput.incomplete,
    savedAt,
    pastRuns: pastRunsState === "stored" ? pastRuns.text : null,
    courseRecords: courseRecordsState === "stored" ? courseRecords.text : null,
    runnerStats: runnerStatsState === "stored" ? runnerStats.text : null,
    relatedCourses: isStoredRelatedCourses(meta.relatedCourses) ? meta.relatedCourses : null,
    pastRunsState,
    courseRecordsState,
    runnerStatsState,
  };
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= PREDICT_INPUT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, PREDICT_INPUT_MAX_CHARS) + TRUNCATION_MARK, truncated: true };
}

function chunksOf(text: string): string[] {
  if (text.length === 0) return [""];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += PREDICT_INPUT_CHUNK_CHARS) {
    parts.push(text.slice(index, index + PREDICT_INPUT_CHUNK_CHARS));
  }
  return parts;
}

async function putChunks(
  kv: KvStore,
  raceKey: string,
  meta: StoredMeta,
  part: ChunkPart,
  countKey: "umabashiraChunks" | "raceInputChunks" | "pastRunsChunks" | "courseRecordsChunks" | "runnerStatsChunks",
  text: string,
): Promise<void> {
  const parts = chunksOf(text);
  meta[countKey] = parts.length;
  for (let index = 0; index < parts.length; index += 1) {
    await kv.put(keys.predictInputChunk(raceKey, part, index), parts[index]!);
  }
}

function sectionState(inline: string | undefined, count: number | undefined, incomplete: boolean): StoredSectionState {
  const present = inline != null || (typeof count === "number" && count > 0);
  if (!present) return "absent";
  if (incomplete) return "incomplete";
  return "stored";
}

export function isStoredRelatedCourses(value: unknown): value is StoredRelatedCourses {
  if (!value || typeof value !== "object") return false;
  const row = value as StoredRelatedCourses;
  if (row.status !== "absent" && row.status !== "ok" && row.status !== "unclosed" && row.status !== "malformed") return false;
  if (!Array.isArray(row.courses) || typeof row.line !== "string" || typeof row.dropped !== "number") return false;
  if (!Number.isInteger(row.dropped) || row.dropped < 0) return false;
  return row.courses.every((course) => {
    if (!course || typeof course !== "object") return false;
    const item = course as { track?: unknown; surface?: unknown; distance?: unknown };
    return typeof item.track === "string" && item.track !== "" && typeof item.surface === "string" && item.surface !== "" && typeof item.distance === "number" && Number.isInteger(item.distance);
  });
}

async function readText(
  kv: KvStore,
  raceKey: string,
  part: ChunkPart,
  inline: string | undefined,
  count: number | undefined,
): Promise<{ text: string; incomplete: boolean }> {
  if (inline != null) return { text: inline, incomplete: false };
  if (!count) return { text: "", incomplete: false };
  const parts: string[] = [];
  let incomplete = false;
  for (let index = 0; index < count; index += 1) {
    const chunk = await kv.get(keys.predictInputChunk(raceKey, part, index));
    if (chunk == null) {
      incomplete = true;
      continue;
    }
    parts.push(chunk);
  }
  return { text: parts.join(""), incomplete };
}

async function deleteChunks(kv: KvStore, raceKey: string): Promise<void> {
  const previous = await kvGetJson<StoredMeta>(kv, keys.predictInput(raceKey));
  const counts: Array<[ChunkPart, number]> = [
    ["u", previous?.umabashiraChunks ?? 0],
    ["r", previous?.raceInputChunks ?? 0],
    ["p", previous?.pastRunsChunks ?? 0],
    ["c", previous?.courseRecordsChunks ?? 0],
    ["s", previous?.runnerStatsChunks ?? 0],
  ];
  for (const [part, count] of counts) {
    for (let index = 0; index < count; index += 1) {
      await kv.delete(keys.predictInputChunk(raceKey, part, index));
    }
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
