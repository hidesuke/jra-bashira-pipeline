import { kvGetJson, keys } from "./kv";
import { JobError, type KvStore } from "./types";

export interface StoredPrompt {
  version: string;
  system: string;
  /** Dify の user メッセージ。コースもレースも本文をそのまま入れる。 */
  user: string;
}

export async function loadPrompt(kv: KvStore, stage: "course" | "race"): Promise<StoredPrompt> {
  const stored = await kvGetJson<StoredPrompt & { text?: unknown }>(kv, keys.prompt(stage));
  if (!stored) {
    throw new JobError(`KV に ${keys.prompt(stage)} がありません。scripts/put-prompts.mjs で v1 を入れてください`, false);
  }
  if (typeof stored.system !== "string" || stored.system.trim() === "") {
    throw new JobError(
      `${keys.prompt(stage)} は {"version","system","user"} です。v1 より前の {"text"} は使いません。scripts/put-prompts.mjs で入れ直してください`,
      false,
    );
  }
  if (typeof stored.version !== "string" || stored.version.trim() === "") {
    throw new JobError(`${keys.prompt(stage)} の version が空です`, false);
  }
  const user = typeof stored.user === "string" ? stored.user : "";
  if (user.trim() === "") {
    throw new JobError(`${keys.prompt(stage)} の user が空です`, false);
  }
  return { version: stored.version.trim(), system: stored.system, user };
}
