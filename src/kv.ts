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

/** 429 の待ち。1 秒から倍々で、数回まで。 */
export const KV_PUT_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Workers KV の「同一キーは 1 秒に 1 回」で返る 429。 */
export function isKvRateLimit(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err && (err as { status?: unknown }).status === 429) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("429") || message.includes("Too Many Requests");
}

export async function kvPutJson(
  kv: KvStore,
  key: string,
  value: unknown,
  expirationTtl?: number,
  sleep: (ms: number) => Promise<void> = sleepMs,
): Promise<void> {
  const body = JSON.stringify(value);
  const options = expirationTtl ? { expirationTtl } : undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await kv.put(key, body, options);
      return;
    } catch (err) {
      const wait = KV_PUT_BACKOFF_MS[attempt];
      if (wait == null || !isKvRateLimit(err)) throw err;
      await sleep(wait);
    }
  }
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
