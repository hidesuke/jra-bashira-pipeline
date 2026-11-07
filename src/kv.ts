import { JobError, type KvStore } from "./types";

export const keys = {
  job: (raceKey: string) => `job:v1:${raceKey}`,
  lock: (raceKey: string) => `lock:v1:${raceKey}`,
  notionPage: (raceKey: string) => `notion:page:v1:${raceKey}`,
  models: "config:models",
  modelsPrevious: "config:models:previous",
  modelsHistory: "config:models:history",
  geminiModels: "cache:v2:gemini-models",
  prompt: (stage: "course" | "race") => `prompt:v2:${stage}`,
};

export async function kvGetJson<T>(kv: KvStore, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new JobError(`KV の ${key} を JSON として読めません`, false);
  }
}

export async function kvPutJson(
  kv: KvStore,
  key: string,
  value: unknown,
  expirationTtl?: number,
): Promise<void> {
  await kv.put(key, JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined);
}

export class MemoryKv implements KvStore {
  private readonly store = new Map<string, { value: string; exp?: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | null> {
    const row = this.store.get(key);
    if (!row) return null;
    if (row.exp != null && row.exp <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const exp = options?.expirationTtl ? this.now() + options.expirationTtl * 1000 : undefined;
    this.store.set(key, { value, exp });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
