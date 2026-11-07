import { kvGetJson, keys } from "./kv";
import { JobError, type KvStore } from "./types";

export interface StoredPrompt {
  version: string;
  text: string;
}

export async function loadPrompt(kv: KvStore, stage: "course" | "race"): Promise<StoredPrompt> {
  const stored = await kvGetJson<StoredPrompt>(kv, keys.prompt(stage));
  if (!stored) {
    throw new JobError(
      `KV に ${keys.prompt(stage)} がありません。scripts/put-prompts.mjs でプロンプト本文と版番号を入れてください`,
      false,
    );
  }
  if (typeof stored.version !== "string" || stored.version.trim() === "" || typeof stored.text !== "string" || stored.text.trim() === "") {
    throw new JobError(`${keys.prompt(stage)} は {"version":"...","text":"..."} である必要があります`, false);
  }
  return { version: stored.version, text: stored.text };
}

export function renderPrompt(prompt: StoredPrompt, data: unknown): string {
  return `${prompt.text.trim()}\n\n# 入力データ\n${JSON.stringify(data, null, 2)}\n`;
}
