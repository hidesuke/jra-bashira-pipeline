import { keys, kvGetJson } from "./kv";
import { PREDICT_INPUT_CHUNK_CHARS, PREDICT_INPUT_MAX_CHARS } from "./predict-input";
import type { KvStore } from "./types";

/**
 * 確認用に残す LLM の入出力。
 * Workers KV の値は 25MiB まで。馬柱の保存と同じく、10 万文字で分割し、1 項目は 50 万文字で切る。
 * システムプロンプトは入れない。
 */
const TRUNCATION_MARK = "\n…（KV の保存上限に合わせて切り詰め）";

const PARTS = {
  courseUser: "cu",
  courseOutput: "co",
  raceOutput: "ro",
} as const;

type TextField = keyof typeof PARTS;

export interface LlmTrace {
  coursePromptVersion: string | null;
  racePromptVersion: string | null;
  courseModel: string | null;
  raceModel: string | null;
  courseUser: string | null;
  courseOutput: string | null;
  raceOutput: string | null;
  /** レース予想の検索クエリ。未記録は null。空配列は記録済みで 0 件。 */
  raceWebSearchQueries: string[] | null;
  truncated: boolean;
  incomplete: boolean;
}

export interface LlmTracePatch {
  coursePromptVersion?: string | null;
  racePromptVersion?: string | null;
  courseModel?: string | null;
  raceModel?: string | null;
  courseUser?: string | null;
  courseOutput?: string | null;
  raceOutput?: string | null;
  raceWebSearchQueries?: string[] | null;
}

interface TraceMeta {
  v: 1;
  coursePromptVersion: string | null;
  racePromptVersion: string | null;
  courseModel: string | null;
  raceModel: string | null;
  raceWebSearchQueries: string[] | null;
  truncated: boolean;
  courseUser?: string;
  courseOutput?: string;
  raceOutput?: string;
  courseUserChunks?: number;
  courseOutputChunks?: number;
  raceOutputChunks?: number;
}

export async function saveLlmTrace(
  kv: KvStore,
  raceKey: string,
  patch: LlmTracePatch,
): Promise<{ truncated: boolean }> {
  const previous = await loadLlmTrace(kv, raceKey);
  const courseUser = clip(pick(patch.courseUser, previous?.courseUser));
  const courseOutput = clip(pick(patch.courseOutput, previous?.courseOutput));
  const raceOutput = clip(pick(patch.raceOutput, previous?.raceOutput));
  const truncated =
    Boolean(previous?.truncated) || courseUser.truncated || courseOutput.truncated || raceOutput.truncated;
  const texts: Record<TextField, string | null> = {
    courseUser: courseUser.text,
    courseOutput: courseOutput.text,
    raceOutput: raceOutput.text,
  };
  await deleteChunks(kv, raceKey);
  const meta: TraceMeta = {
    v: 1,
    coursePromptVersion: pick(patch.coursePromptVersion, previous?.coursePromptVersion) ?? null,
    racePromptVersion: pick(patch.racePromptVersion, previous?.racePromptVersion) ?? null,
    courseModel: pick(patch.courseModel, previous?.courseModel) ?? null,
    raceModel: pick(patch.raceModel, previous?.raceModel) ?? null,
    raceWebSearchQueries: cleanQueries(pick(patch.raceWebSearchQueries, previous?.raceWebSearchQueries) ?? null),
    truncated,
  };
  const inline: TraceMeta = { ...meta, ...presentTexts(texts) };
  if (JSON.stringify(inline).length <= PREDICT_INPUT_CHUNK_CHARS) {
    Object.assign(meta, presentTexts(texts));
  } else {
    for (const field of Object.keys(PARTS) as TextField[]) {
      const text = texts[field];
      if (text == null) continue;
      const chunks = chunksOf(text);
      meta[chunkCountKey(field)] = chunks.length;
      for (let index = 0; index < chunks.length; index += 1) {
        await kv.put(keys.llmTraceChunk(raceKey, PARTS[field], index), chunks[index]!);
      }
    }
  }
  await kv.put(keys.llmTrace(raceKey), JSON.stringify(meta));
  return { truncated };
}

export async function loadLlmTrace(kv: KvStore, raceKey: string): Promise<LlmTrace | null> {
  const meta = await kvGetJson<TraceMeta>(kv, keys.llmTrace(raceKey));
  if (!meta || meta.v !== 1) return null;
  const courseUser = await readText(kv, raceKey, "cu", meta.courseUser, meta.courseUserChunks);
  const courseOutput = await readText(kv, raceKey, "co", meta.courseOutput, meta.courseOutputChunks);
  const raceOutput = await readText(kv, raceKey, "ro", meta.raceOutput, meta.raceOutputChunks);
  return {
    coursePromptVersion: meta.coursePromptVersion ?? null,
    racePromptVersion: meta.racePromptVersion ?? null,
    courseModel: meta.courseModel ?? null,
    raceModel: meta.raceModel ?? null,
    courseUser: courseUser.text,
    courseOutput: courseOutput.text,
    raceOutput: raceOutput.text,
    raceWebSearchQueries: cleanQueries(meta.raceWebSearchQueries ?? null),
    truncated: Boolean(meta.truncated),
    incomplete: courseUser.incomplete || courseOutput.incomplete || raceOutput.incomplete,
  };
}

function pick<T>(next: T | undefined, previous: T | null | undefined): T | null {
  if (next !== undefined) return next;
  return previous ?? null;
}

function presentTexts(texts: Record<TextField, string | null>): Partial<Record<TextField, string>> {
  const out: Partial<Record<TextField, string>> = {};
  for (const field of Object.keys(PARTS) as TextField[]) {
    const text = texts[field];
    if (text != null) out[field] = text;
  }
  return out;
}

function chunkCountKey(field: TextField): "courseUserChunks" | "courseOutputChunks" | "raceOutputChunks" {
  if (field === "courseUser") return "courseUserChunks";
  if (field === "courseOutput") return "courseOutputChunks";
  return "raceOutputChunks";
}

function clip(text: string | null): { text: string | null; truncated: boolean } {
  if (text == null) return { text: null, truncated: false };
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

function cleanQueries(value: string[] | null): string[] | null {
  if (value == null) return null;
  return value.filter((item) => typeof item === "string");
}

async function readText(
  kv: KvStore,
  raceKey: string,
  part: "cu" | "co" | "ro",
  inline: string | undefined,
  count: number | undefined,
): Promise<{ text: string | null; incomplete: boolean }> {
  if (inline != null) return { text: inline, incomplete: false };
  if (!count) return { text: null, incomplete: false };
  const parts: string[] = [];
  let incomplete = false;
  for (let index = 0; index < count; index += 1) {
    const chunk = await kv.get(keys.llmTraceChunk(raceKey, part, index));
    if (chunk == null) {
      incomplete = true;
      continue;
    }
    parts.push(chunk);
  }
  return { text: parts.join(""), incomplete };
}

async function deleteChunks(kv: KvStore, raceKey: string): Promise<void> {
  const previous = await kvGetJson<TraceMeta>(kv, keys.llmTrace(raceKey));
  const counts: Array<["cu" | "co" | "ro", number]> = [
    ["cu", previous?.courseUserChunks ?? 0],
    ["co", previous?.courseOutputChunks ?? 0],
    ["ro", previous?.raceOutputChunks ?? 0],
  ];
  for (const [part, count] of counts) {
    for (let index = 0; index < count; index += 1) {
      await kv.delete(keys.llmTraceChunk(raceKey, part, index));
    }
  }
}
