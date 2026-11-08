import { describe, expect, it } from "vitest";
import { handleRequest, type HttpDeps } from "../src/http";
import type { JobState } from "../src/job";
import { keys, MemoryKv } from "../src/kv";
import { saveLlmTrace } from "../src/llm-trace";
import { savePredictInput } from "../src/predict-input";
import type { JobMessage } from "../src/types";

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
        gemini: {
          course: {
            finishReason: "STOP",
            modelVersion: "mv-course",
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 2,
              thoughtsTokenCount: 3,
              totalTokenCount: 6,
            },
            webSearchQueryCount: 1,
            webSearchQueries: ["福島 芝 1600"],
          },
          race: {
            finishReason: "MAX_TOKENS",
            modelVersion: "mv-race",
            usageMetadata: {
              promptTokenCount: 4,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 6,
              totalTokenCount: 15,
            },
          },
        },
      }),
    );
    const job = await handleRequest(authed("/admin/jobs?race_key=20261107-03-11"), http);
    const body = await job.text();
    expect(job.status).toBe(200);
    expect(body).not.toContain(secret);
    expect(body).not.toContain("courseText");
    expect(body).toContain("prompt:v2:course");
    expect(body).toContain("\"course_summary\":null");
    const listed = JSON.parse(body) as {
      gemini: {
        course: { finishReason: string; webSearchQueryCount: number; webSearchQueries: string[]; usageMetadata: { thoughtsTokenCount: number } };
        race: { finishReason: string; webSearchQueries?: string[] };
      };
    };
    expect(listed.gemini.course).toMatchObject({
      finishReason: "STOP",
      modelVersion: "mv-course",
      webSearchQueryCount: 1,
      webSearchQueries: ["福島 芝 1600"],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 6 },
    });
    expect(listed.gemini.race).toEqual({
      finishReason: "MAX_TOKENS",
      modelVersion: "mv-race",
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, thoughtsTokenCount: 6, totalTokenCount: 15 },
    });
    expect(listed.gemini.race.webSearchQueries).toBeUndefined();
  });

  it("returns the stored course summary without the prompt body", async () => {
    const { http, kv } = deps();
    await kv.put(
      keys.job("20261107-03-11"),
      JSON.stringify({
        runId: "run-1",
        race: { raceKey: "20261107-03-11" },
        requestedBy: "Grok Bot",
        phase: "done",
        notionPageId: null,
        courseVariant: null,
        odds: null,
        prediction: { courseText: "SECRET_PROMPT_BODY" },
        courseSummary: {
          status: "ok",
          text: "コースデータ要約\n先頭: 1頭",
          error: null,
          periodFrom: "2021-11-06",
          periodTo: "2026-11-06",
          raceCount: 40,
          raceCountTruncated: false,
        },
      }),
    );
    const job = await handleRequest(authed("/admin/jobs?race_key=20261107-03-11"), http);
    const summary = (await job.json()) as {
      course_summary: string;
      course_summary_error: string | null;
      course_summary_period: { from: string; to: string };
      course_summary_race_count: number;
    };
    expect(job.status).toBe(200);
    expect(summary.course_summary).toContain("先頭: 1頭");
    expect(summary.course_summary_error).toBeNull();
    expect(summary.course_summary_period).toEqual({ from: "2021-11-06", to: "2026-11-06" });
    expect(summary.course_summary_race_count).toBe(40);
    expect(JSON.stringify(summary)).not.toContain("SECRET_PROMPT_BODY");
  });

  it("returns stored predict input only behind Access", async () => {
    const { http, kv } = deps();
    const open = await handleRequest(new Request("https://worker.example/admin/jobs/input?race_key=20261108-05-11"), http);
    expect(open.status).toBe(403);
    const race = {
      raceKey: "20261108-05-11",
      raceId: "20261108-05-11",
      date: "2026-11-08",
      venue: "東京",
      venueCode: "05",
      raceNumber: 11,
    };
    const state: JobState = {
      runId: "run-1",
      race,
      requestedBy: "Grok Bot",
      phase: "done",
      remarks: "",
      baba: null,
      raceRow: null,
      entries: [{ horse_number: 4, horse_name: "ミラージュナイト", weight_to_carry_kg: 57 }],
      formTasks: [],
      odds: null,
      courseVariant: null,
      statTasks: [],
      prediction: null,
      notionPageId: null,
      consistencyWarnings: [
        {
          horseName: "ミラージュナイト",
          kind: "finish",
          raceName: "目黒記念",
          claimed: "2着",
          actual: "4着",
          snippet: "目黒記念で2着",
          message: "ミラージュナイトの目黒記念は4着だが、予想本文は2着と書いている",
        },
      ],
      predictInput: { stored: true, truncated: false, umabashiraBytes: 4, raceInputBytes: 4 },
      updatedAt: "2026-11-08T00:00:00.000Z",
    };
    await kv.put(keys.job(race.raceKey), JSON.stringify(state));
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-1",
      umabashira: "馬柱BODY",
      raceInput: "入力BODY",
      horses: [
        {
          horseName: "ミラージュナイト",
          horseNumber: 4,
          resolvedName: "ミラージュナイト",
          resolutionStatus: "unique",
          pastRunCount: 1,
          birthDate: "2022-03-30",
          careerStarts: 12,
          prevOfficialResult: 1,
          prevDistance: 2600,
          prevSurface: "芝",
          daysSinceLastRace: 105,
          weightToCarryKg: 57,
          pastRuns: [{ raceName: "目黒記念", date: "2026-05-31", officialResult: 4, surface: "芝", distance: 2500 }],
        },
      ],
    });
    const listed = await handleRequest(authed("/admin/jobs/input?race_key=20261108-05-11&include=umabashira"), http);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      umabashira?: string;
      race_input?: string;
      horses: Array<{ horse_name: string; resolution_status: string; past_run_count: number; career_starts: number }>;
      warnings: Array<{ message: string }>;
    };
    expect(body.umabashira).toBe("馬柱BODY");
    expect(body.race_input).toBeUndefined();
    expect(body.horses[0]).toMatchObject({ horse_name: "ミラージュナイト", resolution_status: "unique", past_run_count: 1, career_starts: 12 });
    expect(body.warnings[0]?.message).toContain("2着");
    const full = await handleRequest(authed("/admin/jobs/input?race_key=20261108-05-11"), http);
    const fullBody = (await full.json()) as { race_input?: string };
    expect(fullBody.race_input).toBe("入力BODY");
  });

  it("returns a race inspection in json and markdown without secrets or the system prompt", async () => {
    const { http, kv } = deps();
    const open = await handleRequest(new Request("https://worker.example/admin/inspect?race_key=20261108-05-11"), http);
    expect(open.status).toBe(403);
    const missing = await handleRequest(authed("/admin/inspect"), http);
    expect(missing.status).toBe(400);
    const absent = await handleRequest(authed("/admin/inspect?race_key=20261108-05-11"), http);
    expect(absent.status).toBe(404);
    const badFormat = await handleRequest(authed("/admin/inspect?race_key=20261108-05-11&format=html"), http);
    expect(badFormat.status).toBe(400);

    const raceKey = "20261108-05-11";
    const courseOutput = `${"あ".repeat(9000)}ENDMARK`;
    const raceOutput = "### レース情報\n先行有利の全文です\n```json\n{}\n```";
    const state = {
      runId: "run-inspect",
      race: {
        raceKey,
        raceId: raceKey,
        date: "2026-11-08",
        venue: "東京",
        venueCode: "05",
        raceNumber: 11,
      },
      requestedBy: "Grok Bot",
      phase: "done",
      remarks: "ユーザー備考",
      baba: {
        venue: {
          venueName: "東京",
          weather: "晴",
          cushion: 9.1,
          turf: { condition: "良" },
          apiKey: "gemini-key-secret",
          nested: { refresh_token: "refresh-secret" },
        },
      },
      raceRow: {
        race_name_main: "テストS",
        grade: "G2",
        surface: "芝",
        distance: 1600,
        weather: "曇",
        track_condition: "重",
        notionToken: "notion-secret",
      },
      entries: [],
      formTasks: [],
      odds: {
        source: "get_odds",
        available: true,
        kind: "最終",
        observedAtJst: "2026-11-08T15:00:00+09:00",
        reason: null,
        detail: null,
        horses: [{ horseNumber: 1, selection: "1", odds: 3.2, oddsMin: null, oddsMax: null, status: null, kind: "最終", observedAtJst: null }],
      },
      courseVariant: null,
      statTasks: [],
      prediction: {
        courseText: courseOutput,
        courseModel: "gemini-flash-latest",
        raceModel: "gemini-flash-latest",
        courseModelVersion: "mv-course",
        raceModelVersion: "mv-race",
        coursePromptVersion: "course-v9",
        racePromptVersion: "race-v9",
        指数分布: "1強・独走型",
        自信度: "A",
        波乱度: "堅実",
        印: "◎ 1 ア",
        予想本文: "先行有利の全文です",
      },
      notionPageId: "page-1",
      gemini: {
        course: {
          finishReason: "STOP",
          modelVersion: "mv-course",
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, thoughtsTokenCount: 33, totalTokenCount: 66 },
          webSearchQueryCount: 1,
          webSearchQueries: ["東京 芝 1600"],
        },
        race: {
          finishReason: "MAX_TOKENS",
          modelVersion: "mv-race",
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200, thoughtsTokenCount: 300, totalTokenCount: 600 },
        },
      },
      courseSummary: { text: "脚質は先行", error: null, status: "ok" },
      system: "SYS_COURSE_DO_NOT_RETURN",
      geminiApiKey: "gemini-key-secret",
      updatedAt: "2026-11-08T01:00:00.000Z",
    };
    await kv.put(keys.job(raceKey), JSON.stringify(state));
    await kv.put(keys.prompt("course"), JSON.stringify({ version: "course-v9", system: "SYS_COURSE_DO_NOT_RETURN", user: "ignored" }));
    await kv.put(keys.prompt("race"), JSON.stringify({ version: "race-v9", system: "SYS_RACE_DO_NOT_RETURN", user: "ignored" }));
    await savePredictInput(kv, {
      raceKey,
      runId: "run-inspect",
      umabashira: "馬柱の全文",
      raceInput: "レースへ渡したユーザー文",
      horses: [],
    });
    await saveLlmTrace(kv, raceKey, {
      coursePromptVersion: "course-v9",
      racePromptVersion: "race-v9",
      courseModel: "gemini-flash-latest",
      raceModel: "gemini-flash-latest",
      courseUser: "東京\n芝\n1600\n脚質は先行",
      courseOutput,
      raceOutput,
      raceWebSearchQueries: [],
    });

    const listed = await handleRequest(authed(`/admin/inspect?raceKey=${raceKey}`), http);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("content-type")).toContain("application/json");
    const body = await listed.text();
    expect(body).not.toContain("SYS_COURSE_DO_NOT_RETURN");
    expect(body).not.toContain("SYS_RACE_DO_NOT_RETURN");
    expect(body).not.toContain("gemini-key-secret");
    expect(body).not.toContain("refresh-secret");
    expect(body).not.toContain("notion-secret");
    const view = JSON.parse(body) as {
      phase: string;
      race: { venue: string; surface: string; distance: number; race_name: string };
      going: { weather: string; condition: string };
      umabashira: string;
      course: { user_text: string; output_text: string; prompt_version: string; finishReason: string; webSearchQueries: string[]; usageMetadata: { thoughtsTokenCount: number } };
      race_prediction: { user_text: string; output_text: string; 予想本文: string; webSearchQueries: string[]; finishReason: string };
      course_summary: string;
      course_summary_error: string | null;
      odds: { available: boolean; horses: Array<{ horse_number: number; odds: number }> };
      baba: { venue: { weather: string; apiKey?: string; nested?: { refresh_token?: string } } };
    };
    expect(view.phase).toBe("done");
    expect(view.race).toMatchObject({ venue: "東京", surface: "芝", distance: 1600, race_name: "テストS" });
    expect(view.going.condition).toBe("重");
    expect(view.going.weather).toBe("曇");
    expect(view.umabashira).toBe("馬柱の全文");
    expect(view.course.user_text).toContain("脚質は先行");
    expect(view.course.output_text).toBe(courseOutput);
    expect(view.course.prompt_version).toBe("course-v9");
    expect(view.course.finishReason).toBe("STOP");
    expect(view.course.webSearchQueries).toEqual(["東京 芝 1600"]);
    expect(view.course.usageMetadata.thoughtsTokenCount).toBe(33);
    expect(view.race_prediction.user_text).toBe("レースへ渡したユーザー文");
    expect(view.race_prediction.output_text).toBe(raceOutput);
    expect(view.race_prediction.予想本文).toBe("先行有利の全文です");
    expect(view.race_prediction.webSearchQueries).toEqual([]);
    expect(view.race_prediction.finishReason).toBe("MAX_TOKENS");
    expect(view.course_summary).toBe("脚質は先行");
    expect(view.course_summary_error).toBeNull();
    expect(view.odds.available).toBe(true);
    expect(view.odds.horses[0]).toMatchObject({ horse_number: 1, odds: 3.2 });
    expect(view.baba.venue.weather).toBe("晴");
    expect(view.baba.venue.apiKey).toBeUndefined();
    expect(view.baba.venue.nested?.refresh_token).toBeUndefined();

    const withoutSummary = JSON.parse((await kv.get(keys.job(raceKey))) ?? "{}") as { courseSummary?: unknown };
    delete withoutSummary.courseSummary;
    await kv.put(keys.job("20261108-05-12"), JSON.stringify({ ...withoutSummary, race: { ...state.race, raceKey: "20261108-05-12" }, phase: "error", error: "止めた", prediction: null }));
    const plain = await handleRequest(authed("/admin/inspect?race_key=20261108-05-12"), http);
    const plainBody = (await plain.json()) as { course_summary: string | null; course_summary_error: string | null; course: { output_text: string | null } };
    expect(plainBody.course_summary).toBeNull();
    expect(plainBody.course_summary_error).toBeNull();
    expect(plainBody.course.output_text).toBeNull();

    const page = await handleRequest(authed(`/admin/inspect?race_key=${raceKey}&format=markdown`), http);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/markdown");
    const markdown = await page.text();
    for (const heading of ["## レース情報", "## エラー", "## 馬場", "## オッズ", "## 馬柱", "## コース分析", "### ユーザー文", "### 出力", "### 呼び出し結果", "## レース予想", "### 予想本文", "## コースデータ要約", "## その他の入力"]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain(courseOutput);
    expect(markdown).toContain("ENDMARK");
    expect(markdown).toContain("レースへ渡したユーザー文");
    expect(markdown).toContain("馬柱の全文");
    expect(markdown).toContain("先行有利の全文です");
    expect(markdown).toContain("finishReason: STOP");
    expect(markdown).toContain("東京 芝 1600");
    expect(markdown).toContain("脚質は先行");
    expect(markdown).not.toContain("SYS_COURSE_DO_NOT_RETURN");
    expect(markdown).not.toContain("gemini-key-secret");
    expect(markdown).not.toContain("（コース分析を省略）");

    const day = await handleRequest(authed("/admin/inspect?date=2026-11-08"), http);
    expect(day.status).toBe(200);
    const listedDay = (await day.json()) as { date: string; jobs: Array<{ race_key: string; phase: string; error: string | null }> };
    expect(listedDay.date).toBe("2026-11-08");
    expect(listedDay.jobs.map((job) => job.race_key)).toEqual(["20261108-05-11", "20261108-05-12"]);
    expect(listedDay.jobs[0]).toMatchObject({ phase: "done", error: null });
    expect(listedDay.jobs[1]).toMatchObject({ phase: "error", error: "止めた" });
    const dayPage = await handleRequest(authed("/admin/inspect?date=20261108&format=markdown"), http);
    expect(await dayPage.text()).toContain("`20261108-05-11` phase=done");

    await kv.put(keys.job("20261108-05-09"), "SECRET_JOB_BODY");
    const broken = await handleRequest(authed("/admin/inspect?date=2026-11-08"), http);
    const brokenText = await broken.text();
    expect(brokenText).not.toContain("SECRET_JOB_BODY");
    expect(brokenText).toContain("20261108-05-09");
  });
});
