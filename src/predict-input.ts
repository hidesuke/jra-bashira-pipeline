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

export interface PredictInputRecord {
  raceKey: string;
  runId: string;
  umabashira: string;
  raceInput: string;
  horses: HorseFormSnapshot[];
  truncated: boolean;
  incomplete: boolean;
}

interface StoredMeta {
  v: 1;
  runId: string;
  truncated: boolean;
  umabashiraBytes: number;
  raceInputBytes: number;
  horses: HorseFormSnapshot[];
  umabashira?: string;
  raceInput?: string;
  umabashiraChunks?: number;
  raceInputChunks?: number;
}

export async function savePredictInput(
  kv: KvStore,
  input: { raceKey: string; runId: string; umabashira: string; raceInput: string; horses: HorseFormSnapshot[] },
): Promise<{ truncated: boolean; umabashiraBytes: number; raceInputBytes: number }> {
  const umabashira = clip(input.umabashira);
  const raceInput = clip(input.raceInput);
  const truncated = umabashira.truncated || raceInput.truncated;
  const horses = input.horses;
  await deleteChunks(kv, input.raceKey);
  const meta: StoredMeta = {
    v: 1,
    runId: input.runId,
    truncated,
    umabashiraBytes: utf8Bytes(umabashira.text),
    raceInputBytes: utf8Bytes(raceInput.text),
    horses,
  };
  const inline = JSON.stringify({ umabashira: umabashira.text, raceInput: raceInput.text, horses });
  if (inline.length <= PREDICT_INPUT_CHUNK_CHARS) {
    meta.umabashira = umabashira.text;
    meta.raceInput = raceInput.text;
  } else {
    const umabashiraChunks = chunksOf(umabashira.text);
    const raceChunks = chunksOf(raceInput.text);
    meta.umabashiraChunks = umabashiraChunks.length;
    meta.raceInputChunks = raceChunks.length;
    for (let index = 0; index < umabashiraChunks.length; index += 1) {
      await kv.put(keys.predictInputChunk(input.raceKey, "u", index), umabashiraChunks[index]!);
    }
    for (let index = 0; index < raceChunks.length; index += 1) {
      await kv.put(keys.predictInputChunk(input.raceKey, "r", index), raceChunks[index]!);
    }
  }
  await kv.put(keys.predictInput(input.raceKey), JSON.stringify(meta));
  return { truncated, umabashiraBytes: meta.umabashiraBytes, raceInputBytes: meta.raceInputBytes };
}

export async function loadPredictInput(kv: KvStore, raceKey: string): Promise<PredictInputRecord | null> {
  const meta = await kvGetJson<StoredMeta>(kv, keys.predictInput(raceKey));
  if (!meta || meta.v !== 1) return null;
  const umabashira = await readText(kv, raceKey, "u", meta.umabashira, meta.umabashiraChunks);
  const raceInput = await readText(kv, raceKey, "r", meta.raceInput, meta.raceInputChunks);
  return {
    raceKey,
    runId: meta.runId,
    umabashira: umabashira.text,
    raceInput: raceInput.text,
    horses: Array.isArray(meta.horses) ? meta.horses : [],
    truncated: Boolean(meta.truncated),
    incomplete: umabashira.incomplete || raceInput.incomplete,
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

async function readText(
  kv: KvStore,
  raceKey: string,
  part: "u" | "r",
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
  const umabashiraChunks = previous?.umabashiraChunks ?? 0;
  const raceInputChunks = previous?.raceInputChunks ?? 0;
  for (let index = 0; index < umabashiraChunks; index += 1) {
    await kv.delete(keys.predictInputChunk(raceKey, "u", index));
  }
  for (let index = 0; index < raceInputChunks; index += 1) {
    await kv.delete(keys.predictInputChunk(raceKey, "r", index));
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
