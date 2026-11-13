import { JobError, type KvListResult, type KvStore } from "./types";

export const keys = {
  job: (raceKey: string) => `job:v1:${raceKey}`,
  lock: (raceKey: string) => `lock:v1:${raceKey}`,
  /** その開催日のバッチ投入の要約。レースごとのキーは増やさない。 */
  batch: (date: string) => `batch:v1:${date}`,
  notionPage: (raceKey: string) => `notion:page:v1:${raceKey}`,
  models: "config:models",
  modelsPrevious: "config:models:previous",
  modelsHistory: "config:models:history",
  /** 開催日の get_races に渡す limit。正の整数の JSON。無い・不正ならコードの既定。 */
  getRacesLimit: "config:get-races-limit",
  geminiModels: "cache:v2:gemini-models",
  prompt: (stage: "course" | "race") => `prompt:v2:${stage}`,
  /**
   * 予想に渡した馬柱とユーザー文。本文が長いときは u / r の分割キーに置く。
   * 近10走は p、コース成績は c、出走馬のコース成績は s。プロンプト文は入れない。
   */
  predictInput: (raceKey: string) => `input:v1:${raceKey}`,
  predictInputChunk: (raceKey: string, part: "u" | "r" | "p" | "c" | "s", index: number) => `input:v1:${raceKey}:${part}:${index}`,
  /**
   * 確認用に残す LLM のユーザー文と出力全文。システムプロンプトは入れない。
   * 長い本文は cu / co / ro の分割キーに置く。
   */
  llmTrace: (raceKey: string) => `trace:v1:${raceKey}`,
  llmTraceChunk: (raceKey: string, part: "cu" | "co" | "ro", index: number) => `trace:v1:${raceKey}:${part}:${index}`,
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

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const names = [...this.store.keys()]
      .filter((name) => name.startsWith(prefix) && this.alive(name))
      .sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const offset = Number.isInteger(start) && start > 0 ? start : 0;
    const slice = names.slice(offset, offset + limit);
    const next = offset + slice.length;
    const done = next >= names.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: done,
      cursor: done ? undefined : String(next),
    };
  }

  private alive(key: string): boolean {
    const row = this.store.get(key);
    if (!row) return false;
    if (row.exp != null && row.exp <= this.now()) return false;
    return true;
  }
}
