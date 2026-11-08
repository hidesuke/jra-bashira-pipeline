import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import { handleRequest, type HttpDeps } from "../src/http";
import { keys, MemoryKv } from "../src/kv";
import { blocksNewRun, handleJobMessage } from "../src/pipeline";
import { LOCK_TTL_SECONDS, QUEUE_MAX_RETRIES, type JobMessage } from "../src/types";

const raceKey = "20261108-05-11";
const raceBody = JSON.stringify({ race_id: raceKey });

function authed(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("cf-access-jwt-assertion", "token");
  headers.set("cf-access-client-id", "grok-id");
  return new Request(`https://worker.example${path}`, { ...init, headers });
}

function setup(kind: "auth" | "upstream") {
  let nowMs = Date.parse("2026-11-08T06:00:00Z");
  const kv = new MemoryKv(() => nowMs);
  const messages: JobMessage[] = [];
  const bashira: BashiraPort = {
    async listTools() {
      if (kind === "auth") {
        return { ok: false, code: "auth", retryable: false, message: "BASHIRA の refresh に失敗しました" };
      }
      return { ok: false, code: "upstream", retryable: true, message: "一時的な失敗" };
    },
    async callTool() {
      return { ok: false, code: "upstream", retryable: true, message: "no" };
    },
    async callTools() {
      return { ok: false, code: "upstream", retryable: true, message: "no", results: [] };
    },
  };
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
      accessTeamDomain: "https://hdsk.cloudflareaccess.com",
      accessAud: "aud-tag",
      accessClientIdGrok: "grok-id",
      accessClientIdMuse: "muse-id",
    },
    kv,
    now: () => new Date(nowMs),
    enqueue: async (message) => {
      messages.push(message);
    },
    verifyJwt: async () => ({ common_name: "ignored" }),
    oauth: {
      async getStatus() {
        return { registered: true, authorized: false, needsReauth: false, expiresAt: null, lastError: null };
      },
      async beginAuthorization() {
        return { url: "https://example.test/authorize" };
      },
      async completeAuthorization() {
        return { ok: true };
      },
    },
  };
  return {
    kv,
    http,
    messages,
    bashira,
    now: () => new Date(nowMs),
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

async function postRun(http: HttpDeps): Promise<Response> {
  return handleRequest(authed("/run", { method: "POST", body: raceBody }), http);
}

describe("failed jobs release the race lock", () => {
  it("accepts a new run after a non-retried error and keeps the Notion page id", async () => {
    const env = setup("auth");
    await env.kv.put(keys.notionPage(raceKey), "page-bashira");
    expect((await postRun(env.http)).status).toBe(202);
    expect((await postRun(env.http)).status).toBe(409);
    const decision = await handleJobMessage(env.messages[0]!, {
      kv: env.kv,
      config: env.http.config,
      bashira: env.bashira,
      enqueue: env.http.enqueue,
      now: env.now,
    });
    expect(decision).toBe("ack");
    const job = JSON.parse((await env.kv.get(keys.job(raceKey))) ?? "{}") as { phase?: string };
    expect(job.phase).toBe("error");
    expect(await env.kv.get(keys.lock(raceKey))).toBeNull();
    expect(await env.kv.get(keys.notionPage(raceKey))).toBe("page-bashira");
    const again = await postRun(env.http);
    expect(again.status).toBe(202);
    expect(env.messages).toHaveLength(2);
  });

  it("keeps the lock while a retry is still allowed, then releases it on the last attempt", async () => {
    const env = setup("upstream");
    expect((await postRun(env.http)).status).toBe(202);
    const deps = {
      kv: env.kv,
      config: env.http.config,
      bashira: env.bashira,
      enqueue: env.http.enqueue,
      now: env.now,
    };
    expect(
      await handleJobMessage(env.messages[0]!, deps, { attempt: 1, maxRetries: QUEUE_MAX_RETRIES }),
    ).toBe("retry");
    expect((await postRun(env.http)).status).toBe(409);
    expect(
      await handleJobMessage(env.messages[0]!, deps, { attempt: QUEUE_MAX_RETRIES, maxRetries: QUEUE_MAX_RETRIES }),
    ).toBe("ack");
    const job = JSON.parse((await env.kv.get(keys.job(raceKey))) ?? "{}") as { phase?: string; error?: string };
    expect(job.phase).toBe("error");
    expect(job.error).toContain("一時的な失敗");
    expect((await postRun(env.http)).status).toBe(202);
  });

  it("accepts a run when the lock is stale or the job already failed", async () => {
    const env = setup("auth");
    const freshLock = JSON.stringify({ runId: "old", expiresAt: env.now().getTime() + 60_000 });
    await env.kv.put(keys.lock(raceKey), JSON.stringify({ runId: "old", expiresAt: env.now().getTime() - 1 }));
    expect((await postRun(env.http)).status).toBe(202);

    await env.kv.put(keys.lock(raceKey), freshLock);
    await env.kv.put(
      keys.job(raceKey),
      JSON.stringify({
        runId: "old",
        phase: "collect",
        error: "MCP が Mcp-Session-Id を返しませんでした",
        updatedAt: env.now().toISOString(),
      }),
    );
    expect((await postRun(env.http)).status).toBe(202);

    await env.kv.put(keys.lock(raceKey), freshLock);
    await env.kv.put(
      keys.job(raceKey),
      JSON.stringify({
        runId: "old",
        phase: "collect",
        updatedAt: new Date(env.now().getTime() - (LOCK_TTL_SECONDS + 1) * 1000).toISOString(),
      }),
    );
    expect(blocksNewRun({ phase: "collect", updatedAt: new Date(0).toISOString() }, env.now().getTime())).toBe(false);
    expect((await postRun(env.http)).status).toBe(202);
  });

  it("rejects a new run while the job is active even after the lock key is gone", async () => {
    const env = setup("auth");
    await env.kv.put(
      keys.job(raceKey),
      JSON.stringify({
        phase: "predict",
        updatedAt: env.now().toISOString(),
        race: { raceKey },
      }),
    );
    expect((await postRun(env.http)).status).toBe(409);
    expect(env.messages).toHaveLength(0);
  });

  it("does not collect a start that lost the lock to another run", async () => {
    const env = setup("auth");
    await env.kv.put(
      keys.lock(raceKey),
      JSON.stringify({ runId: "winner", requestedBy: "cron", expiresAt: env.now().getTime() + 60_000 }),
    );
    const decision = await handleJobMessage(
      {
        kind: "start",
        runId: "loser",
        requestedBy: "cron",
        race: {
          raceKey,
          raceId: raceKey,
          date: "2026-11-08",
          venue: "東京",
          venueCode: "05",
          raceNumber: 11,
        },
      },
      {
        kv: env.kv,
        config: env.http.config,
        bashira: env.bashira,
        enqueue: env.http.enqueue,
        now: env.now,
      },
    );
    expect(decision).toBe("ack");
    expect(await env.kv.get(keys.job(raceKey))).toBeNull();
    expect(await env.kv.get(keys.lock(raceKey))).toContain("winner");
  });
});

describe("health build id", () => {
  it("returns the version tag when Workers metadata is present", async () => {
    const env = setup("auth");
    env.http.version = { id: "version-1", tag: "abc123", timestamp: "2026-11-08T06:00:00Z" };
    const body = (await (await handleRequest(new Request("https://worker.example/health"), env.http)).json()) as {
      commit: string | null;
      version_id: string | null;
    };
    expect(body.commit).toBe("abc123");
    expect(body.version_id).toBe("version-1");
  });

  it("uses the build-time SHA when the version tag is empty", async () => {
    const env = setup("auth");
    env.http.version = { id: "version-1", tag: "", timestamp: "2026-11-08T06:00:00Z" };
    env.http.buildCommit = "deadbeef";
    const body = (await (await handleRequest(new Request("https://worker.example/health"), env.http)).json()) as {
      commit: string | null;
    };
    expect(body.commit).toBe("deadbeef");
    env.http.buildCommit = "";
    const empty = (await (await handleRequest(new Request("https://worker.example/health"), env.http)).json()) as {
      commit: string | null;
    };
    expect(empty.commit).toBeNull();
  });
});
