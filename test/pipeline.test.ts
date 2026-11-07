import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import { keys, MemoryKv } from "../src/kv";
import { handleJobMessage, type PipelineDeps } from "../src/pipeline";
import type { JobMessage, RaceRef } from "../src/types";
import { bashiraTools, notionSchema } from "./fixture";

const race: RaceRef = {
  raceKey: "20261107-03-11",
  raceId: "20261107-03-11",
  date: "2026-11-07",
  venue: "福島",
  venueCode: "03",
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
  defaultModel: "gemini-flash-latest",
};

async function drain(
  env: { deps: PipelineDeps; pending: JobMessage[] },
  first: JobMessage,
): Promise<Array<"ack" | "retry">> {
  env.pending.push(first);
  const results: Array<"ack" | "retry"> = [];
  while (env.pending.length > 0) {
    const message = env.pending.shift()!;
    results.push(await handleJobMessage(message, env.deps));
  }
  return results;
}

function harness(options?: { odds?: "ok" | "error"; notion?: "create" | "ambiguous"; auth?: boolean }) {
  const kv = new MemoryKv();
  const pending: JobMessage[] = [];
  const statBatches: number[] = [];
  const geminiBodies: Array<Record<string, unknown>> = [];
  const notionCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  const deleted = new Set<string>();
  let created = false;

  const bashira: BashiraPort = {
    async listTools() {
      if (options?.auth) {
        return {
          ok: false,
          code: "auth",
          retryable: false,
          message: "BASHIRA の refresh に失敗しました（invalid_grant）。/oauth/start から再認可してください。",
        };
      }
      return { ok: true, tools: bashiraTools };
    },
    async callTool(name) {
      if (name === "get_races") {
        return {
          ok: true,
          data: {
            rows: [
              {
                race_status: "upcoming",
                surface: "芝",
                distance: 1600,
                race_name_main: "テストS",
                race_track: "福島",
                race_number: 11,
                rail_type: "A",
              },
            ],
          },
        };
      }
      if (name === "get_entries") {
        return {
          ok: true,
          data: {
            rows: [
              { horse_number: 1, horse_name: "ア", jockey_name: "騎手A", sire_name: "父一", broodmare_sire_name: "母父一" },
              {
                horse_number: 2,
                horse_name: "イ",
                jockey_name: "騎手B",
                sire_name: "父二",
                broodmare_sire_name: "母父二",
                race_abnormality: "出走取消",
              },
            ],
          },
        };
      }
      if (options?.odds === "error") return { ok: false, code: "upstream", retryable: true, message: "odds down" };
      return {
        ok: true,
        data: {
          columns: ["selection", "odds", "odds_kind", "odds_observed_at", "status"],
          rows: [["1", 3.1, "最終", "2026-11-07T06:04:00Z", null]],
        },
      };
    },
    async callTools(calls) {
      statBatches.push(calls.length);
      return {
        ok: true,
        results: calls.map(() => ({ columns: ["starts", "wins"], rows: [[40, 8]] })),
      };
    },
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (url.startsWith(config.babaUrl)) {
      return Response.json({
        fetchedAt: "2026-11-07T06:00:00Z",
        venues: [{ venueName: "福島", turf: { condition: "良" } }],
      });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiBodies.push(body ?? {});
      const json = Boolean((body?.generationConfig as { responseMimeType?: string } | undefined)?.responseMimeType);
      const text = json
        ? JSON.stringify({ 指数分布: "1強", 自信度: "A", 波乱度: "堅実", 印: "◎1", 予想本文: "先行有利" })
        : "コースは先行が残る";
      const modelVersion = json ? "gemini-race-001" : "gemini-course-001";
      return Response.json({ modelVersion, candidates: [{ content: { parts: [{ text }] } }] });
    }
    if (url.includes("api.notion.com")) {
      const path = new URL(url).pathname;
      notionCalls.push({ method, path, body });
      if (path === "/v1/databases/db" && method === "GET") return Response.json(notionSchema);
      if (path === "/v1/databases/db/query") {
        if (options?.notion === "ambiguous") {
          return Response.json({ has_more: false, results: [{ id: "page-a" }, { id: "page-b" }] });
        }
        const results = [{ id: "dify-page" }];
        if (created) results.push({ id: "page-1" });
        return Response.json({ has_more: false, results });
      }
      if (path === "/v1/pages" && method === "POST") {
        created = true;
        return Response.json({ id: "page-1" });
      }
      if (path === "/v1/pages/page-1" && method === "GET") {
        return Response.json({
          id: "page-1",
          properties: {
            日付: { date: { start: "2026-11-07" } },
            競馬場: { select: { name: "福島" } },
            レース: { select: { name: "11" } },
          },
        });
      }
      if (path.startsWith("/v1/blocks/") && path.endsWith("/children") && method === "GET") {
        const id = path.split("/")[3];
        if (id === "dify-page") {
          return Response.json({ results: [{ id: "dify-b", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Difyの予想" }] } }] });
        }
        if (options?.notion === "ambiguous") {
          return Response.json({ results: [{ id: `${id}-b`, type: "paragraph", paragraph: { rich_text: [{ plain_text: "BASHIRAで取得" }] } }] });
        }
        if (deleted.has("page-1-block")) return Response.json({ results: [] });
        return Response.json({
          results: [{ id: "page-1-block", type: "paragraph", paragraph: { rich_text: [{ plain_text: "BASHIRAで取得" }] } }],
        });
      }
      if (method === "DELETE") {
        deleted.add("page-1-block");
        return Response.json({});
      }
      if (method === "PATCH") return Response.json({ id: "page-1" });
      return Response.json({ message: `unexpected ${method} ${path}` }, { status: 500 });
    }
    return Response.json({ message: `unexpected ${url}` }, { status: 500 });
  };

  const deps: PipelineDeps = {
    kv,
    config,
    bashira,
    now: () => new Date("2026-11-07T06:00:00Z"),
    fetch: fetchImpl,
    enqueue: async (message) => {
      pending.push(message);
    },
  };
  return { deps, kv, pending, statBatches, geminiBodies, notionCalls, deleted };
}

describe("pipeline", () => {
  it("predicts one race, splits stats, and updates the same Notion page on rerun", async () => {
    const env = harness();
    await env.kv.put(keys.prompt("course"), JSON.stringify({ version: "3", text: "コース分析プロンプト" }));
    await env.kv.put(keys.prompt("race"), JSON.stringify({ version: "4", text: "レース予想プロンプト" }));
    const start: JobMessage = { kind: "start", runId: "run-1", race, requestedBy: "Grok Bot" };
    const results = await drain(env, start);
    expect(results.every((result) => result === "ack")).toBe(true);
    expect(env.statBatches).toEqual([8, 1]);
    expect(env.geminiBodies).toHaveLength(2);
    const coursePrompt = (
      env.geminiBodies[0]?.contents as Array<{ parts: Array<{ text: string }> }>
    )[0]?.parts[0]?.text;
    expect(coursePrompt).toContain('"course_variant": null');
    const created = env.notionCalls.find((call) => call.method === "POST" && call.path === "/v1/pages");
    const children = (created?.body as { children?: Array<{ paragraph?: { rich_text?: Array<{ text?: { content?: string } }> } }> }).children;
    expect(children?.[0]?.paragraph?.rich_text?.[0]?.text?.content).toBe("BASHIRAで取得");
    const bodyText = JSON.stringify(children);
    expect(bodyText).toContain("指定モデル（course）: gemini-flash-latest");
    expect(bodyText).toContain("応答モデル modelVersion（course）: gemini-course-001");
    expect(bodyText).toContain("応答モデル modelVersion（race）: gemini-race-001");
    expect(bodyText).toContain("プロンプト版（course）: 3");
    expect(bodyText).toContain("オッズ種別: 最終");
    expect(bodyText).toContain("2026-11-07T15:04:00+09:00");
    expect(bodyText).toContain("course_variant: null");
    await expect(env.kv.get(keys.notionPage(race.raceKey))).resolves.toBe("page-1");

    const again = await drain(env, { kind: "start", runId: "run-2", race, requestedBy: "Muse" });
    expect(again.every((result) => result === "ack")).toBe(true);
    expect(env.notionCalls.filter((call) => call.method === "POST" && call.path === "/v1/pages")).toHaveLength(1);
    const patches = env.notionCalls.filter((call) => call.method === "PATCH").map((call) => call.path);
    expect(patches).toContain("/v1/pages/page-1");
    expect(env.deleted.has("page-1-block")).toBe(true);
    expect(env.notionCalls.some((call) => call.path.includes("dify"))).toBe(true);
    expect(env.notionCalls.filter((call) => call.method === "DELETE").every((call) => call.path.includes("page-1-block"))).toBe(true);
  });

  it("stops when BASHIRA refresh fails and does not call Gemini", async () => {
    const env = harness({ auth: true });
    const result = await handleJobMessage(
      { kind: "start", runId: "run-auth", race, requestedBy: "Grok Bot" },
      env.deps,
    );
    expect(result).toBe("ack");
    expect(env.geminiBodies).toHaveLength(0);
    expect(env.pending).toHaveLength(0);
    const job = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as { phase?: string; error?: string };
    expect(job.phase).toBe("error");
    expect(job.error).toContain("refresh");
  });

  it("stops instead of guessing when two BASHIRA pages match", async () => {
    const env = harness({ notion: "ambiguous" });
    await env.kv.put(keys.prompt("course"), JSON.stringify({ version: "3", text: "コース" }));
    await env.kv.put(keys.prompt("race"), JSON.stringify({ version: "4", text: "レース" }));
    const results = await drain(env, { kind: "start", runId: "run-amb", race, requestedBy: "Muse" });
    expect(results.at(-1)).toBe("ack");
    expect(env.notionCalls.some((call) => call.method === "POST" && call.path === "/v1/pages")).toBe(false);
    const job = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as { phase?: string; error?: string };
    expect(job.phase).toBe("error");
    expect(job.error).toContain("複数");
  });

  it("continues when odds cannot be fetched", async () => {
    const env = harness({ odds: "error" });
    await env.kv.put(keys.prompt("course"), JSON.stringify({ version: "1", text: "コース" }));
    await env.kv.put(keys.prompt("race"), JSON.stringify({ version: "1", text: "レース" }));
    await drain(env, { kind: "start", runId: "run-odds", race, requestedBy: "Grok Bot" });
    const created = env.notionCalls.find((call) => call.method === "POST" && call.path === "/v1/pages");
    expect(JSON.stringify(created?.body)).toContain("取得エラー");
  });
});
