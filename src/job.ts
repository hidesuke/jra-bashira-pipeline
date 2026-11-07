import type { OddsSummary } from "./odds";
import type { StatTask } from "./stats";
import { kvGetJson, kvPutJson, keys } from "./kv";
import type { KvStore, RaceRef } from "./types";

export interface StoredPrediction {
  courseText: string;
  courseModel: string;
  raceModel: string;
  courseModelVersion: string | null;
  raceModelVersion: string | null;
  coursePromptVersion: string;
  racePromptVersion: string;
  指数分布: string;
  自信度: string;
  波乱度: string;
  印: string;
  予想本文: string;
}

export interface JobState {
  runId: string;
  race: RaceRef;
  requestedBy: string;
  phase: "collect" | "stats" | "predict" | "notion" | "done" | "error";
  error?: string;
  baba: unknown;
  raceRow: Record<string, unknown> | null;
  entries: Record<string, unknown>[];
  odds: OddsSummary | null;
  /** 内・外のデータは無い。常に null。 */
  courseVariant: null;
  statTasks: StatTask[];
  prediction: StoredPrediction | null;
  notionPageId: string | null;
  updatedAt: string;
}

export async function loadJob(kv: KvStore, raceKey: string): Promise<JobState | null> {
  return kvGetJson<JobState>(kv, keys.job(raceKey));
}

export async function saveJob(kv: KvStore, state: JobState): Promise<void> {
  await kvPutJson(kv, keys.job(state.race.raceKey), state);
}
