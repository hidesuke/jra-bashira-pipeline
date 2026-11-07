import { describe, expect, it } from "vitest";
import { handleRequest, type HttpDeps } from "../src/http";
import { keys, MemoryKv } from "../src/kv";
import type { JobMessage } from "../src/types";

const config = {
  babaUrl: "https://baba.test/latest",
  geminiApiKey: "gemini-key",
  notionToken: "notion-token",
  notionDatabaseId: "db",
  statsPeriodYears: 5,
  statsMinStarts: 30,
  broodmareMinStarts: 50,
  defaultModel: "gemini-flash-latest",
  accessTeamDomain: "https://team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessClientIdGrok: "grok-id",
  accessClientIdMuse: "muse-id",
};

function deps(fetchImpl?: typeof fetch): { http: HttpDeps; messages: JobMessage[]; kv: MemoryKv } {
  const kv = new MemoryKv();
  const messages: JobMessage[] = [];
  const http: HttpDeps = {
    config,
    kv,
    now: () => new Date("2026-11-07T06:00:00Z"),
    enqueue: async (message) => {
      messages.push(message);
    },
    fetch: fetchImpl,
    verifyJwt: async () => ({ common_name: "ignored" }),
    oauth: {
      async getStatus() {
        return { registered: true, authorized: true, needsReauth: false, expiresAt: null, lastError: null };
      },
      async beginAuthorization() {
        return { url: "https://mcp.bashira.omninode.co.jp/authorize?state=abc" };
      },
      async completeAuthorization() {
        return { ok: true };
      },
    },
  };
  return { http, messages, kv };
}

function authed(path: string, init?: RequestInit, clientId = "grok-id"): Request {
  const headers = new Headers(init?.headers);
  headers.set("cf-access-jwt-assertion", "token");
  headers.set("cf-access-client-id", clientId);
  return new Request(`https://worker.example${path}`, { ...init, headers });
}

describe("http", () => {
  it("rejects /run and /admin without an Access JWT", async () => {
    const { http } = deps();
    const response = await handleRequest(new Request("https://worker.example/run", { method: "POST" }), http);
    expect(response.status).toBe(403);
    const admin = await handleRequest(new Request("https://worker.example/admin/models"), http);
    expect(admin.status).toBe(403);
  });

  it("enqueues exactly one race and records the service token", async () => {
    const { http, messages } = deps();
    const response = await handleRequest(
      authed("/run", { method: "POST", body: JSON.stringify({ race_id: "20261107-03-11" }) }),
      http,
    );
    expect(response.status).toBe(202);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "start", requestedBy: "Grok Bot", race: { raceKey: "20261107-03-11" } });
    const again = await handleRequest(
      authed("/run", { method: "POST", body: JSON.stringify({ date: "2026-11-07", venue: "福島", race_number: 11 }) }, "muse-id"),
      http,
    );
    expect(again.status).toBe(409);
    expect(messages).toHaveLength(1);
  });

  it("lists, updates, and restores models", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        models: [
          { name: "models/gemini-flash-latest", displayName: "Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-pro-latest", displayName: "Pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    const { http, kv } = deps(fetchImpl);
    const listed = await handleRequest(authed("/admin/models"), http);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { current: { course: string }; models: Array<{ name: string }> };
    expect(listedBody.current).toEqual({ course: "gemini-flash-latest", race: "gemini-flash-latest" });
    expect(listedBody.models.map((model) => model.name)).toEqual(["gemini-flash-latest", "gemini-pro-latest"]);

    const updated = await handleRequest(
      authed("/admin/models", {
        method: "PUT",
        body: JSON.stringify({ course: "gemini-pro-latest", race: "gemini-flash-latest" }),
      }, "muse-id"),
      http,
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { current: { course: string }; caller: string };
    expect(updatedBody.current.course).toBe("gemini-pro-latest");
    expect(updatedBody.caller).toBe("Muse");

    const rejected = await handleRequest(
      authed("/admin/models", { method: "PUT", body: JSON.stringify({ race: "gemini-missing" }) }),
      http,
    );
    expect(rejected.status).toBe(400);

    const restored = await handleRequest(authed("/admin/models/restore", { method: "POST" }), http);
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as { current: { course: string } };
    expect(restoredBody.current.course).toBe("gemini-flash-latest");
    const history = JSON.parse((await kv.get(keys.modelsHistory)) ?? "[]") as Array<{ caller: string; restored?: boolean }>;
    expect(history.map((entry) => entry.caller)).toEqual(["Muse", "Grok Bot"]);
    expect(history[1]?.restored).toBe(true);
  });

  it("leaves the OAuth callback public", async () => {
    const { http } = deps();
    const response = await handleRequest(new Request("https://worker.example/oauth/callback?code=abc&state=abc"), http);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("認可が完了");
    const health = await handleRequest(new Request("https://worker.example/health"), http);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, mode: "one-race", commit: null, version_id: null });
  });

  it("does not return prompt text or raw KV values from job lookups", async () => {
    const { http, kv } = deps();
    const secret = "SECRET_PROMPT_BODY";
    await kv.put(keys.job("20261107-03-11"), secret);
    const broken = await handleRequest(authed("/admin/jobs?race_key=20261107-03-11"), http);
    expect(broken.status).toBe(400);
    const brokenBody = await broken.text();
    expect(brokenBody).toContain("job:v1:20261107-03-11");
    expect(brokenBody).not.toContain(secret);
    await kv.put(
      keys.job("20261107-03-11"),
      JSON.stringify({
        runId: "run-1",
        race: { raceKey: "20261107-03-11" },
        requestedBy: "Grok Bot",
        phase: "error",
        error: "KV に prompt:v2:course がありません",
        notionPageId: null,
        courseVariant: null,
        odds: null,
        prediction: { courseText: secret, 予想本文: secret },
      }),
    );
    const job = await handleRequest(authed("/admin/jobs?race_key=20261107-03-11"), http);
    const body = await job.text();
    expect(job.status).toBe(200);
    expect(body).not.toContain(secret);
    expect(body).not.toContain("courseText");
    expect(body).toContain("prompt:v2:course");
  });
});
