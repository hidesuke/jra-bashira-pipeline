import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import { ExternalBudget } from "../src/budget";
import type { FormTask } from "../src/form";
import { handleRequest, type HttpDeps } from "../src/http";
import type { JobState } from "../src/job";
import { keys, MemoryKv } from "../src/kv";
import {
  NOTIFY_ERROR_MAX_CHARS,
  NOTIFY_TIMEOUT_MS,
  buildRaceFailedPayload,
  notifyRaceFailed,
  shortError,
  webhookHeaders,
  type RaceFailedInput,
} from "../src/notify";
import { handleJobMessage, type PipelineDeps } from "../src/pipeline";
import { EXTERNAL_BUDGET, EXTERNAL_SUBREQUEST_LIMIT, JobError, QUEUE_MAX_RETRIES, httpStatusOf, type RaceRef } from "../src/types";

const race: RaceRef = {
  raceKey: "20261108-05-11",
  raceId: "20261108-05-11",
  date: "2026-11-08",
  venue: "東京",
  venueCode: "05",
  raceNumber: 11,
};

const occurredAt = new Date("2026-11-08T07:31:00.000Z");

function input(overrides?: Partial<RaceFailedInput>): RaceFailedInput {
  return {
    raceKey: race.raceKey,
    runId: "run-1",
    phaseAtFailure: "predict",
    error: "Gemini が失敗しました: HTTP 500",
    attempts: 3,
    httpStatus: 500,
    occurredAt,
    ...overrides,
  };
}

describe("race_failed payload", () => {
  it("builds the final-failure body and omits http_status when it is unknown", () => {
    const payload = buildRaceFailedPayload(input());
    expect(payload).toEqual({
      type: "race_failed",
      race_key: "20261108-05-11",
      run_id: "run-1",
      phase_at_failure: "predict",
      error: "Gemini が失敗しました: HTTP 500",
      attempts: 3,
      http_status: 500,
      inspect_path: "/admin/inspect?race_key=20261108-05-11",
      jobs_path: "/admin/jobs?race_key=20261108-05-11",
      occurred_at_jst: "2026-11-08T16:31:00+09:00",
    });
    const unknown = buildRaceFailedPayload(input({ httpStatus: null, error: "一時的な失敗" }));
    expect(unknown.http_status).toBeUndefined();
    expect(JSON.parse(JSON.stringify(unknown))).not.toHaveProperty("http_status");
  });

  it("keeps the error short and on one line", () => {
    const long = `  一行目\n${"あ".repeat(NOTIFY_ERROR_MAX_CHARS)}  `;
    const text = shortError(long);
    expect(text.length).toBe(NOTIFY_ERROR_MAX_CHARS);
    expect(text.endsWith("...")).toBe(true);
    expect(text).not.toContain("\n");
    expect(buildRaceFailedPayload(input({ error: long })).error).toBe(text);
  });

  it("reads an HTTP status from JobError or from the message", () => {
    expect(httpStatusOf(new JobError("Notion HTTP 429: slow", true, 429))).toBe(429);
    expect(httpStatusOf(new JobError("Gemini (m) が失敗しました: HTTP 500", true))).toBe(500);
    expect(httpStatusOf(new Error("一時的な失敗"))).toBeNull();
  });
});

describe("webhook headers", () => {
  it("sends Bearer on Authorization and the raw key on any other header", () => {
    const bearer = webhookHeaders({ url: "https://hooks.example/notify", key: "super-secret" });
    expect(bearer.get("authorization")).toBe("Bearer super-secret");
    expect(bearer.get("content-type")).toBe("application/json");

    const named = webhookHeaders({
      key: "super-secret",
      keyHeader: "X-Webhook-Key",
    });
    expect(named.get("x-webhook-key")).toBe("super-secret");
    expect(named.get("authorization")).toBeNull();

    const explicit = webhookHeaders({ key: "super-secret", keyHeader: " authorization " });
    expect(explicit.get("authorization")).toBe("Bearer super-secret");

    const open = webhookHeaders({ url: "https://hooks.example/notify" });
    expect(open.get("authorization")).toBeNull();
    expect([...open.keys()]).toEqual(["content-type"]);

    const json = webhookHeaders({ key: "super-secret", keyHeader: "Content-Type" });
    expect(json.get("content-type")).toBe("application/json");
    expect(json.get("authorization")).toBeNull();
  });
});

describe("notifyRaceFailed", () => {
  it("does nothing when the URL is unset and does not spend the budget", async () => {
    const budget = new ExternalBudget();
    let calls = 0;
    const logs: string[] = [];
    await notifyRaceFailed(
      { url: "  ", key: "super-secret" },
      input(),
      {
        budget,
        fetch: async () => {
          calls += 1;
          return new Response(null, { status: 204 });
        },
        log(event, fields) {
          logs.push(JSON.stringify({ event, ...fields }));
        },
      },
    );
    await notifyRaceFailed(undefined, input(), { budget });
    expect(calls).toBe(0);
    expect(budget.used).toBe(0);
    expect(logs).toEqual([]);
  });

  it("posts JSON, counts one subrequest, and logs only the status", async () => {
    const budget = new ExternalBudget();
    const logs: string[] = [];
    let seenUrl = "";
    let init: RequestInit | undefined;
    await notifyRaceFailed(
      { url: "https://hooks.example/secret-path", key: "super-secret", keyHeader: "X-Webhook-Key" },
      input({ httpStatus: null }),
      {
        budget,
        fetch: async (url, request) => {
          seenUrl = String(url);
          init = request;
          return new Response("echo super-secret", { status: 200 });
        },
        log(event, fields) {
          logs.push(JSON.stringify({ event, ...fields }));
        },
      },
    );
    expect(seenUrl).toBe("https://hooks.example/secret-path");
    expect(budget.used).toBe(1);
    expect(NOTIFY_TIMEOUT_MS).toBe(10_000);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("x-webhook-key")).toBe("super-secret");
    const body = JSON.parse(String(init?.body)) as { type: string; http_status?: number };
    expect(body.type).toBe("race_failed");
    expect(body.http_status).toBeUndefined();
    expect(logs).toEqual([JSON.stringify({ event: "notify_sent", type: "race_failed", status: 200 })]);
    expect(logs.join("\n")).not.toContain("hooks.example");
    expect(logs.join("\n")).not.toContain("super-secret");
  });

  it("swallows HTTP errors, network errors, and a full soft budget without failing the caller", async () => {
    const logs: string[] = [];
    const log = (event: string, fields?: Record<string, unknown>) => {
      logs.push(JSON.stringify({ event, ...fields }));
    };
    const rejected = new ExternalBudget();
    await expect(
      notifyRaceFailed(
        { url: "https://hooks.example/secret-path", key: "super-secret" },
        input(),
        {
          budget: rejected,
          fetch: async () => new Response("no", { status: 502 }),
          log,
        },
      ),
    ).resolves.toBeUndefined();
    expect(rejected.used).toBe(1);

    const offline = new ExternalBudget();
    await notifyRaceFailed(
      { url: "https://hooks.example/secret-path", key: "super-secret" },
      input(),
      {
        budget: offline,
        fetch: async () => {
          throw new Error("connect https://hooks.example/secret-path super-secret");
        },
        log,
      },
    );
    expect(offline.used).toBe(1);

    const full = new ExternalBudget();
    full.used = EXTERNAL_BUDGET;
    let extra = 0;
    await notifyRaceFailed(
      { url: "https://hooks.example/secret-path", key: "super-secret" },
      input(),
      {
        budget: full,
        fetch: async () => {
          extra += 1;
          return new Response(null, { status: 204 });
        },
        log,
      },
    );
    expect(extra).toBe(1);
    expect(full.used).toBe(EXTERNAL_BUDGET + 1);

    const blocked = new ExternalBudget();
    blocked.used = EXTERNAL_SUBREQUEST_LIMIT;
    await notifyRaceFailed(
      { url: "https://hooks.example/secret-path", key: "super-secret" },
      input(),
      {
        budget: blocked,
        fetch: async () => {
          extra += 1;
          return new Response(null, { status: 204 });
        },
        log,
      },
    );
    expect(blocked.used).toBe(EXTERNAL_SUBREQUEST_LIMIT);
    expect(extra).toBe(1);

    const tiny = new ExternalBudget(0);
    await notifyRaceFailed(
      { url: "https://hooks.example/secret-path", key: "super-secret" },
      input(),
      {
        budget: tiny,
        fetch: async () => {
          extra += 1;
          return new Response(null, { status: 204 });
        },
        log,
      },
    );
    expect(tiny.used).toBe(0);
    expect(extra).toBe(1);
    const text = logs.join("\n");
    expect(text).not.toContain("hooks.example");
    expect(text).not.toContain("super-secret");
    expect(text).toContain('"status":502');
    expect(text).toContain('"status":null');
  });
});

function formTask(name: string): FormTask {
  return {
    horseName: name,
    horseNumber: 1,
    status: "pending",
    args: { filters: { horse_name: name } },
    rows: [],
  };
}

function jobState(): JobState {
  return {
    runId: "run-1",
    race,
    requestedBy: "Grok Bot",
    phase: "form",
    remarks: "",
    baba: null,
    raceRow: null,
    entries: [],
    formTasks: [formTask("ア")],
    odds: null,
    courseVariant: null,
    statTasks: [],
    prediction: null,
    notionPageId: null,
    updatedAt: "2026-11-08T07:31:00.000Z",
  };
}

function failingPort(fail: Set<string>): BashiraPort {
  return {
    async listTools() {
      return { ok: true, tools: [] };
    },
    async callTool(_name, args) {
      const horse = (args as { filters?: { horse_name?: string } }).filters?.horse_name ?? "";
      if (fail.has(horse)) return { ok: false, code: "upstream", retryable: true, message: "近走を取れません" };
      return { ok: true, data: { rows: [] } };
    },
    async callTools() {
      return { ok: true, results: [] };
    },
  };
}

function pipeline(kv: MemoryKv, options?: { url?: string; keyHeader?: string; fetch?: typeof fetch; log?: PipelineDeps["log"] }): PipelineDeps {
  return {
    kv,
    config: {
      babaUrl: "https://baba.test/latest",
      geminiApiKey: "gemini-key",
      notionToken: "notion-token",
      notionDatabaseId: "db",
      statsPeriodYears: 5,
      statsMinStarts: 30,
      broodmareMinStarts: 50,
      courseSummaryMinCount: 30,
      defaultModel: "gemini-flash-latest",
    },
    bashira: failingPort(new Set(["ア"])),
    now: () => occurredAt,
    clock: () => 0,
    sleep: async () => {},
    enqueue: async () => {},
    notify: options?.url === undefined ? undefined : { url: options.url, key: "super-secret", keyHeader: options.keyHeader },
    fetch: options?.fetch,
    log: options?.log,
  };
}

describe("final race failure", () => {
  it("records a retry without notifying, then posts race_failed once retries stop", async () => {
    const kv = new MemoryKv();
    await kv.put(keys.job(race.raceKey), JSON.stringify(jobState()));
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    const logs: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      posts.push({ url: String(url), init });
      return new Response("ignored", { status: 500 });
    };
    const log: PipelineDeps["log"] = (event, fields) => {
      logs.push(JSON.stringify({ event, ...fields }));
    };
    const deps = pipeline(kv, { url: "https://hooks.example/secret-path", fetch: fetchImpl, log });
    const message = { kind: "form" as const, runId: "run-1", raceKey: race.raceKey };
    const retrying = await handleJobMessage(message, deps, { attempt: 2, maxRetries: QUEUE_MAX_RETRIES });
    expect(retrying).toBe("retry");
    expect(posts).toHaveLength(0);
    const waiting = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(waiting.phase).toBe("form");
    expect(waiting.error).toBeUndefined();
    expect(waiting.retry).toEqual({ attempt: 2, maxAttempts: 3, lastError: "近走を取れません" });

    const budget = new ExternalBudget();
    const done = await handleJobMessage(
      message,
      { ...deps, budget },
      { attempt: QUEUE_MAX_RETRIES, maxRetries: QUEUE_MAX_RETRIES },
    );
    expect(done).toBe("ack");
    expect(budget.used).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://hooks.example/secret-path");
    expect(new Headers(posts[0]?.init?.headers).get("authorization")).toBe("Bearer super-secret");
    expect(JSON.parse(String(posts[0]?.init?.body))).toMatchObject({
      type: "race_failed",
      race_key: race.raceKey,
      run_id: "run-1",
      phase_at_failure: "form",
      error: "近走を取れません",
      attempts: 3,
      inspect_path: "/admin/inspect?race_key=20261108-05-11",
      jobs_path: "/admin/jobs?race_key=20261108-05-11",
      occurred_at_jst: "2026-11-08T16:31:00+09:00",
    });
    const failed = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(failed.phase).toBe("error");
    expect(failed.error).toContain("近走を取れません");
    expect(failed.retry).toBeUndefined();
    const text = logs.join("\n");
    expect(text).toContain('"status":500');
    expect(text).not.toContain("hooks.example");
    expect(text).not.toContain("super-secret");
  });

  it("still acks the race when the webhook throws, and skips the call when unset", async () => {
    const kv = new MemoryKv();
    await kv.put(keys.job(race.raceKey), JSON.stringify(jobState()));
    let calls = 0;
    const decision = await handleJobMessage(
      { kind: "form", runId: "run-1", raceKey: race.raceKey },
      pipeline(kv, {
        url: "https://hooks.example/secret-path",
        fetch: async () => {
          calls += 1;
          throw new Error("https://hooks.example/secret-path super-secret");
        },
        log(event, fields) {
          const text = JSON.stringify({ event, ...fields });
          expect(text).not.toContain("hooks.example");
          expect(text).not.toContain("super-secret");
        },
      }),
      { attempt: QUEUE_MAX_RETRIES, maxRetries: QUEUE_MAX_RETRIES },
    );
    expect(decision).toBe("ack");
    expect(calls).toBe(1);
    const failed = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(failed.phase).toBe("error");

    const quiet = new MemoryKv();
    await quiet.put(keys.job(race.raceKey), JSON.stringify(jobState()));
    const budget = new ExternalBudget();
    const skipped = await handleJobMessage(
      { kind: "form", runId: "run-1", raceKey: race.raceKey },
      { ...pipeline(quiet), budget, fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      } },
      { attempt: QUEUE_MAX_RETRIES, maxRetries: QUEUE_MAX_RETRIES },
    );
    expect(skipped).toBe("ack");
    expect(calls).toBe(1);
    expect(budget.used).toBe(0);
  });

  it("drops the retry mark once the next attempt gets past the failure", async () => {
    const kv = new MemoryKv();
    await kv.put(keys.job(race.raceKey), JSON.stringify(jobState()));
    const fail = new Set(["ア"]);
    const deps: PipelineDeps = {
      ...pipeline(kv),
      bashira: failingPort(fail),
    };
    expect(
      await handleJobMessage({ kind: "form", runId: "run-1", raceKey: race.raceKey }, deps, {
        attempt: 1,
        maxRetries: QUEUE_MAX_RETRIES,
      }),
    ).toBe("retry");
    fail.delete("ア");
    expect(
      await handleJobMessage({ kind: "form", runId: "run-1", raceKey: race.raceKey }, deps, {
        attempt: 2,
        maxRetries: QUEUE_MAX_RETRIES,
      }),
    ).toBe("ack");
    const saved = JSON.parse((await kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(saved.phase).not.toBe("error");
    expect(saved.retry).toBeUndefined();
    expect(saved.error).toBeUndefined();
  });
});

describe("GET /admin/jobs retry line", () => {
  it("shows retrying attempt 2/3 while the phase stays put", async () => {
    const kv = new MemoryKv();
    await kv.put(
      keys.job(race.raceKey),
      JSON.stringify({
        ...jobState(),
        phase: "predict",
        retry: { attempt: 2, maxAttempts: 3, lastError: "Gemini HTTP 500" },
      }),
    );
    const http: HttpDeps = {
      config: {
        babaUrl: "https://baba.test/latest",
        geminiApiKey: "gemini-key",
        notionToken: "notion-token",
        notionDatabaseId: "db",
        statsPeriodYears: 5,
        statsMinStarts: 30,
        broodmareMinStarts: 50,
        courseSummaryMinCount: 30,
        defaultModel: "gemini-flash-latest",
        accessTeamDomain: "https://team.cloudflareaccess.com",
        accessAud: "aud",
        accessClientIdGrok: "grok-id",
        accessClientIdMuse: "muse-id",
      },
      kv,
      now: () => occurredAt,
      enqueue: async () => {},
      verifyJwt: async () => ({ common_name: "ignored" }),
      oauth: {
        async getStatus() {
          return { registered: true, authorized: true, needsReauth: false, expiresAt: null, lastError: null };
        },
        async beginAuthorization() {
          return { url: "https://example.test/authorize" };
        },
        async completeAuthorization() {
          return { ok: true };
        },
      },
    };
    const headers = new Headers();
    headers.set("cf-access-jwt-assertion", "token");
    headers.set("cf-access-client-id", "grok-id");
    const response = await handleRequest(new Request(`https://worker.example/admin/jobs?race_key=${race.raceKey}`, { headers }), http);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      phase: string;
      error: string | null;
      retry: string | null;
      attempt: number | null;
      max_attempts: number | null;
      last_error: string | null;
    };
    expect(body.phase).toBe("predict");
    expect(body.error).toBeNull();
    expect(body.retry).toBe("retrying attempt 2/3");
    expect(body.attempt).toBe(2);
    expect(body.max_attempts).toBe(3);
    expect(body.last_error).toBe("Gemini HTTP 500");
  });
});
