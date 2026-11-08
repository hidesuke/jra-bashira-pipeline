import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import { FORM_BATCH_SIZE, type FormTask } from "../src/form";
import { JOB_WRITE_MIN_INTERVAL_MS, JobWriter, type JobState } from "../src/job";
import { KV_PUT_BACKOFF_MS, MemoryKv, keys, kvPutJson } from "../src/kv";
import { handleJobMessage, type PipelineDeps } from "../src/pipeline";
import { QUEUE_MAX_RETRIES, type JobMessage, type KvStore, type RaceRef } from "../src/types";

const race: RaceRef = {
  raceKey: "20261108-05-11",
  raceId: "20261108-05-11",
  date: "2026-11-08",
  venue: "東京",
  venueCode: "05",
  raceNumber: 11,
};

const config = {
  babaUrl: "https://baba.test/latest",
  geminiApiKey: "gemini-key",
  notionToken: "notion-token",
  notionDatabaseId: "db",
  statsPeriodYears: 5,
  statsMinStarts: 30,
  broodmareMinStarts: 50,
  courseSummaryMinCount: 30,
  defaultModel: "gemini-flash-latest",
};

function formTask(name: string, number: number, status: FormTask["status"] = "pending"): FormTask {
  return {
    horseName: name,
    horseNumber: number,
    status,
    args: { filters: { horse_name: name } },
    rows: [],
  };
}

function jobState(tasks: FormTask[]): JobState {
  return {
    runId: "run-1",
    race,
    requestedBy: "Grok Bot",
    phase: "form",
    remarks: "",
    baba: null,
    raceRow: null,
    entries: [],
    formTasks: tasks,
    odds: null,
    courseVariant: null,
    statTasks: [],
    prediction: null,
    notionPageId: null,
    updatedAt: "2026-11-08T07:31:00.000Z",
  };
}

class CountingKv extends MemoryKv {
  readonly jobWrites: number[] = [];

  constructor(private readonly stamp: () => number) {
    super();
  }

  override async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (key === keys.job(race.raceKey)) this.jobWrites.push(this.stamp());
    await super.put(key, value, options);
  }
}

class RateLimitKv implements KvStore {
  puts = 0;

  constructor(private readonly failures: number) {}

  async get(_key: string): Promise<string | null> {
    return null;
  }

  async put(_key: string, _value: string): Promise<void> {
    this.puts += 1;
    if (this.puts <= this.failures) throw new Error("KV PUT failed: 429 Too Many Requests");
  }

  async delete(_key: string): Promise<void> {}
}

function bashira(options?: { fail?: Set<string>; advance?: () => void }): BashiraPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listTools() {
      return { ok: false, code: "upstream", retryable: true, message: "一時的な失敗" };
    },
    async callTool(_name, args) {
      options?.advance?.();
      const horse = (args as { filters?: { horse_name?: string } }).filters?.horse_name ?? "";
      calls.push(horse);
      if (options?.fail?.has(horse)) {
        return { ok: false, code: "upstream", retryable: true, message: "近走を取れません" };
      }
      return { ok: true, data: { rows: [] } };
    },
    async callTools() {
      return { ok: true, results: [] };
    },
  };
}

function deps(kv: KvStore, port: BashiraPort, extra?: Partial<PipelineDeps>): PipelineDeps & { pending: JobMessage[] } {
  const pending: JobMessage[] = [];
  return {
    pending,
    kv,
    config,
    bashira: port,
    now: () => new Date("2026-11-08T07:31:00.000Z"),
    enqueue: async (message) => {
      pending.push(message);
    },
    ...extra,
  };
}

describe("kvPutJson retries 429", () => {
  it("waits with exponential backoff starting at 1s and then stores the value", async () => {
    const sleeps: number[] = [];
    let failures = 2;
    let stored: string | null = null;
    const kv: KvStore = {
      async get() {
        return stored;
      },
      async put(_key, value) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("KV PUT failed: 429 Too Many Requests");
        }
        stored = value;
      },
      async delete() {
        stored = null;
      },
    };
    await kvPutJson(kv, "job:v1:race", { ok: true }, undefined, async (ms) => {
      sleeps.push(ms);
    });
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(KV_PUT_BACKOFF_MS[0]).toBeGreaterThanOrEqual(1_000);
    expect(stored).toBe(JSON.stringify({ ok: true }));
  });

  it("does not retry a non-429 failure", async () => {
    let puts = 0;
    const kv: KvStore = {
      async get() {
        return null;
      },
      async put() {
        puts += 1;
        throw new Error("KV PUT failed: 500 Internal Server Error");
      },
      async delete() {},
    };
    await expect(
      kvPutJson(kv, "k", { a: 1 }, undefined, async () => {
        throw new Error("sleep should not be called");
      }),
    ).rejects.toThrow(/500/);
    expect(puts).toBe(1);
  });

  it("throws the 429 after the backoff attempts are used", async () => {
    const sleeps: number[] = [];
    const kv: KvStore = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("KV PUT failed: 429 Too Many Requests");
      },
      async delete() {},
    };
    await expect(kvPutJson(kv, "k", { a: 1 }, undefined, async (ms) => {
      sleeps.push(ms);
    })).rejects.toThrow(/429/);
    expect(sleeps).toEqual([...KV_PUT_BACKOFF_MS]);
  });
});

describe("job write throttle", () => {
  it("keeps state in memory and writes the same key at most once per 1.1s, forcing the final flush", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const kv = new MemoryKv();
    const writer = new JobWriter(
      kv,
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );
    const state = jobState([formTask("ア", 1)]);
    await writer.saveIfDue(state);
    now = 1_500;
    await writer.saveIfDue(state);
    expect(await kv.get(keys.job(race.raceKey))).toBeNull();
    now = 1_000 + JOB_WRITE_MIN_INTERVAL_MS;
    await writer.saveIfDue(state);
    const first = await kv.get(keys.job(race.raceKey));
    expect(first).toContain("ア");
    now += 500;
    state.updatedAt = "2026-11-08T07:31:02.000Z";
    await writer.saveIfDue(state);
    expect(await kv.get(keys.job(race.raceKey))).toBe(first);
    await writer.flush(state);
    expect(sleeps).toEqual([JOB_WRITE_MIN_INTERVAL_MS - 500]);
    const saved = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(saved.updatedAt).toBe("2026-11-08T07:31:02.000Z");
  });

  it("flushes a form batch without writing once per horse, and spaces writes by at least 1.1s", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const kv = new CountingKv(() => now);
    const names = ["ア", "イ", "ウ", "エ", "オ", "カ", "キ", "ク"];
    const state = jobState(names.map((name, index) => formTask(name, index + 1)));
    await kv.put(keys.job(race.raceKey), JSON.stringify(state));
    kv.jobWrites.length = 0;
    const port = bashira({
      advance() {
        now += 600;
      },
    });
    const env = deps(kv, port, {
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const decision = await handleJobMessage({ kind: "form", runId: "run-1", raceKey: race.raceKey }, env);
    expect(decision).toBe("ack");
    expect(port.calls).toEqual(names);
    expect(kv.jobWrites.length).toBeLessThan(names.length);
    expect(kv.jobWrites.length).toBeGreaterThan(0);
    for (let index = 1; index < kv.jobWrites.length; index += 1) {
      expect(kv.jobWrites[index]! - kv.jobWrites[index - 1]!).toBeGreaterThanOrEqual(JOB_WRITE_MIN_INTERVAL_MS);
    }
    expect(sleeps.some((ms) => ms > 0 && ms <= JOB_WRITE_MIN_INTERVAL_MS)).toBe(true);
    const saved = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(saved.formTasks.every((task) => task.status === "done")).toBe(true);
  });
});

describe("persistFailure", () => {
  it("logs the original error and does not throw when saving the failure keeps returning 429", async () => {
    const sleeps: number[] = [];
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const kv = new RateLimitKv(Number.POSITIVE_INFINITY);
    const env = deps(kv, bashira(), {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log(event, fields) {
        logs.push({ event, fields });
      },
    });
    const decision = await handleJobMessage(
      { kind: "start", runId: "run-1", race, requestedBy: "Grok Bot" },
      env,
      { attempt: 1, maxRetries: QUEUE_MAX_RETRIES },
    );
    expect(decision).toBe("retry");
    expect(sleeps).toEqual([...KV_PUT_BACKOFF_MS]);
    expect(kv.puts).toBe(KV_PUT_BACKOFF_MS.length + 1);
    const failed = logs.find((entry) => entry.event === "job_failed");
    const persist = logs.find((entry) => entry.event === "job_persist_failed");
    expect(failed?.fields?.error).toBe("一時的な失敗");
    expect(persist?.fields?.error).toBe("一時的な失敗");
    expect(String(persist?.fields?.saveError)).toContain("429");
    expect(await kv.get(keys.job(race.raceKey))).toBeNull();
  });

  it("stores the original error for /admin/jobs once the 429s clear", async () => {
    const kv = new MemoryKv();
    let failures = 2;
    const flaky: KvStore = {
      async get(key) {
        return kv.get(key);
      },
      async put(key, value, options) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("KV PUT failed: 429 Too Many Requests");
        }
        await kv.put(key, value, options);
      },
      async delete(key) {
        await kv.delete(key);
      },
    };
    const port: BashiraPort = {
      async listTools() {
        return { ok: false, code: "auth", retryable: false, message: "BASHIRA の refresh に失敗しました" };
      },
      async callTool() {
        return { ok: false, code: "upstream", retryable: true, message: "no" };
      },
      async callTools() {
        return { ok: false, code: "upstream", retryable: true, message: "no", results: [] };
      },
    };
    const decision = await handleJobMessage(
      { kind: "start", runId: "run-auth", race, requestedBy: "Grok Bot" },
      deps(flaky, port, { sleep: async () => {} }),
    );
    expect(decision).toBe("ack");
    const saved = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(saved.phase).toBe("error");
    expect(saved.error).toContain("refresh");
  });
});

describe("form resume", () => {
  it("does not refetch horses that were already stored when a later horse fails", async () => {
    const kv = new MemoryKv();
    const tasks = ["ア", "イ", "ウ"].map((name, index) => formTask(name, index + 1));
    await kv.put(keys.job(race.raceKey), JSON.stringify(jobState(tasks)));
    const fail = new Set(["イ"]);
    const port = bashira({ fail });
    const env = deps(kv, port, { clock: () => 0, sleep: async () => {} });
    const first = await handleJobMessage({ kind: "form", runId: "run-1", raceKey: race.raceKey }, env, {
      attempt: 1,
      maxRetries: QUEUE_MAX_RETRIES,
    });
    expect(first).toBe("retry");
    expect(port.calls).toEqual(["ア", "イ"]);
    const midway = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(midway.phase).toBe("form");
    expect(midway.formTasks.map((task) => task.status)).toEqual(["done", "pending", "pending"]);

    port.calls.length = 0;
    fail.delete("イ");
    const second = await handleJobMessage({ kind: "form", runId: "run-1", raceKey: race.raceKey }, env, {
      attempt: 2,
      maxRetries: QUEUE_MAX_RETRIES,
    });
    expect(second).toBe("ack");
    expect(port.calls).toEqual(["イ", "ウ"]);
    const saved = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(saved.formTasks.every((task) => task.status === "done")).toBe(true);
  });

  it("continues a later batch from the horses still pending", async () => {
    const kv = new MemoryKv();
    const names = Array.from({ length: FORM_BATCH_SIZE + 2 }, (_, index) => `馬${index + 1}`);
    await kv.put(
      keys.job(race.raceKey),
      JSON.stringify(jobState(names.map((name, index) => formTask(name, index + 1)))),
    );
    const port = bashira();
    const env = deps(kv, port, { clock: () => 0, sleep: async () => {} });
    await handleJobMessage({ kind: "form", runId: "run-1", raceKey: race.raceKey }, env);
    expect(port.calls).toEqual(names.slice(0, FORM_BATCH_SIZE));
    port.calls.length = 0;
    await handleJobMessage(env.pending[0]!, env);
    expect(port.calls).toEqual(names.slice(FORM_BATCH_SIZE));
  });

  it("keeps fetched horses and records the error on the final attempt", async () => {
    const kv = new MemoryKv();
    await kv.put(
      keys.job(race.raceKey),
      JSON.stringify(jobState([formTask("ア", 1), formTask("イ", 2)])),
    );
    const port = bashira({ fail: new Set(["イ"]) });
    const env = deps(kv, port, { clock: () => 0, sleep: async () => {} });
    const decision = await handleJobMessage({ kind: "form", runId: "run-1", raceKey: race.raceKey }, env, {
      attempt: QUEUE_MAX_RETRIES,
      maxRetries: QUEUE_MAX_RETRIES,
    });
    expect(decision).toBe("ack");
    expect(port.calls).toEqual(["ア", "イ"]);
    const saved = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(saved.phase).toBe("error");
    expect(saved.error).toContain("近走を取れません");
    expect(saved.formTasks.map((task) => [task.horseName, task.status])).toEqual([
      ["ア", "done"],
      ["イ", "pending"],
    ]);
  });
});
