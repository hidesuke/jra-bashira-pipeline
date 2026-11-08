import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import { pageBlocks } from "../src/body";
import { COURSE_USER_DIFY_TOKENS, COURSE_USER_PLACEHOLDERS, RACE_USER_DIFY_TOKENS, RACE_USER_PLACEHOLDERS } from "../src/dify-input";
import type { JobState } from "../src/job";
import { keys, MemoryKv } from "../src/kv";
import { loadPredictInput } from "../src/predict-input";
import { handleJobMessage, NOTION_CONTINUATION_LIMIT, type PipelineDeps } from "../src/pipeline";
import { QUEUE_MAX_RETRIES, type JobMessage, type RaceRef } from "../src/types";
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

function harness(options?: {
  odds?: "ok" | "error";
  notion?: "create" | "ambiguous";
  auth?: boolean;
  existingPageId?: string;
  failArchiveOnce?: boolean;
  externalBudget?: number;
  raceText?: string;
  onEntries?: (args: Record<string, unknown>) => { ok: true; data: unknown } | null;
}) {
  const kv = new MemoryKv();
  const pending: JobMessage[] = [];
  const statBatches: number[] = [];
  const entryCalls: Array<Record<string, unknown>> = [];
  const geminiBodies: Array<Record<string, unknown>> = [];
  const notionCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  const createdIds: string[] = [];
  const archivedIds = new Set<string>();
  let archiveAttempts = 0;

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
    async callTool(name, args) {
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
                grade: "G2",
                race_track: "福島",
                race_number: 11,
                rail_type: "A",
                weather: "曇",
                track_condition: "重",
              },
            ],
          },
        };
      }
      if (name === "get_entries") {
        entryCalls.push(args);
        const custom = options?.onEntries?.(args);
        if (custom) return custom;
        const filters = (args as { filters?: { horse_name?: string } }).filters;
        if (filters?.horse_name) {
          return {
            ok: true,
            data: {
              rows: [
                {
                  horse_name: filters.horse_name,
                  race_meeting_date: "2026-11-07",
                  race_track: "福島",
                  race_number: 11,
                  entry_status: "upcoming",
                },
                {
                  horse_name: filters.horse_name,
                  race_meeting_date: "2026-10-12",
                  race_track: "東京",
                  surface: "芝",
                  distance: 1600,
                  rail_type: "A",
                  track_condition: "良",
                  race_condition: "3勝クラス",
                  race_name_main: "テスト前走",
                  official_result: 2,
                  finish_time_sec: 93.2,
                  time_difference_with_winner_sec: 0.2,
                  first_corner_position: 3,
                  second_corner_position: 3,
                  third_corner_position: 2,
                  fourth_corner_position: 2,
                  last_3f_sec: 33.8,
                  last_3f_rank: 1,
                  jockey_name: "騎手A",
                  weight_to_carry_kg: 56,
                  scheduled_horse_count: 16,
                  win_odds_rank: 4,
                  win_odds: 6.5,
                  entry_status: "finished",
                },
              ],
            },
          };
        }
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
        venues: [
          {
            venueName: "福島",
            weather: "晴",
            cushion: 9.2,
            measuredAt: "11月7日 7時00分",
            turf: { condition: "良", goal: 10.1, corner4: 11.2, goalCondition: "良", corner4Condition: "良" },
            dirt: { condition: "稍重", goal: 8, corner4: 8.4 },
          },
        ],
      });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiBodies.push(body ?? {});
      const userText = ((body?.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined)?.[0]?.parts?.[0]?.text) ?? "";
      const isRace = userText.includes("# 馬柱");
      const text = isRace
        ? (options?.raceText ??
          [
            "### レース情報",
            "- **レース名:** テストS",
            "",
            "### レース総合判定",
            "- **指数分布ステータス:** 【1強・独走型】",
            "- **予想自信度:** 【A】 （差がある）",
            "- **波乱度:** 【堅実】 （順当）",
            "",
            "### 競馬新聞風印予想",
            "- ◎ 1 ア",
            "",
            "先行有利",
          ].join("\n"))
        : "コースは先行が残る";
      const modelVersion = isRace ? "gemini-race-001" : "gemini-course-001";
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
        if (options?.existingPageId && !archivedIds.has(options.existingPageId)) results.push({ id: options.existingPageId });
        for (const id of createdIds) {
          if (!archivedIds.has(id)) results.push({ id });
        }
        return Response.json({ has_more: false, results });
      }
      if (path === "/v1/pages" && method === "POST") {
        const id = `page-${createdIds.length + 1}`;
        createdIds.push(id);
        return Response.json({ id });
      }
      const pageId = path.match(/^\/v1\/pages\/([^/]+)$/)?.[1];
      if (pageId && method === "GET") {
        return Response.json({
          id: pageId,
          archived: archivedIds.has(pageId),
          properties: {
            日付: { date: { start: race.date } },
            競馬場: { select: { name: race.venue } },
            レース: { select: { name: String(race.raceNumber) } },
          },
        });
      }
      if (pageId && method === "PATCH") {
        if (body && typeof body === "object" && (body as { archived?: boolean }).archived === true) {
          archiveAttempts += 1;
          if (options?.failArchiveOnce && archiveAttempts === 1) {
            return Response.json({ message: "unavailable" }, { status: 500 });
          }
          archivedIds.add(pageId);
          return Response.json({ id: pageId, archived: true });
        }
        return Response.json({ id: pageId });
      }
      if (path.startsWith("/v1/blocks/") && path.endsWith("/children") && method === "GET") {
        const id = path.split("/")[3];
        if (id === "dify-page") {
          return Response.json({ results: [{ id: "dify-b", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Difyの予想" }] } }] });
        }
        return Response.json({
          results: [{ id: `${id}-b`, type: "paragraph", paragraph: { rich_text: [{ plain_text: "BASHIRAで取得" }] } }],
        });
      }
      if (path.startsWith("/v1/blocks/") && path.endsWith("/children") && method === "PATCH") {
        return Response.json({});
      }
      if (method === "DELETE") return Response.json({});
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
    clock: () => Date.parse("2026-11-07T06:00:00Z"),
    sleep: async () => {},
    externalBudget: options?.externalBudget,
    enqueue: async (message) => {
      pending.push(message);
    },
  };
  return { deps, kv, pending, statBatches, entryCalls, geminiBodies, notionCalls, archivedIds, createdIds };
}

type PromptStyle = "placeholder" | "dify";

function courseUser(style: PromptStyle): string {
  const tokens = style === "placeholder" ? COURSE_USER_PLACEHOLDERS : COURSE_USER_DIFY_TOKENS;
  return [tokens.venue, tokens.surface, tokens.distance].join("\n");
}

function raceUser(style: PromptStyle): string {
  const tokens = style === "placeholder" ? RACE_USER_PLACEHOLDERS : RACE_USER_DIFY_TOKENS;
  return [tokens.umabashira, tokens.course_analysis, tokens.weather, tokens.condition, tokens.remarks].join("\n");
}

async function seedPrompts(kv: MemoryKv, style: PromptStyle = "placeholder"): Promise<void> {
  await kv.put(keys.prompt("course"), JSON.stringify({ version: "v1", system: "コースシステム", user: courseUser(style) }));
  await kv.put(keys.prompt("race"), JSON.stringify({ version: "v1", system: "予測システム", user: raceUser(style) }));
}

describe("pipeline", () => {
  it("predicts one race, splits stats, and replaces the Notion page on rerun", async () => {
    const env = harness();
    await seedPrompts(env.kv);
    const start: JobMessage = { kind: "start", runId: "run-1", race, requestedBy: "Grok Bot" };
    const results = await drain(env, start);
    expect(results.every((result) => result === "ack")).toBe(true);
    expect(env.statBatches).toEqual([8, 1]);
    expect(env.geminiBodies).toHaveLength(2);
    const courseBody = env.geminiBodies[0] as {
      systemInstruction?: { parts?: Array<{ text?: string }> };
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const courseUser = courseBody.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(courseBody.systemInstruction?.parts?.[0]?.text).toBe("コースシステム");
    expect(courseUser).toContain("福島");
    expect(courseUser).toContain("芝");
    expect(courseUser).toContain("1600");
    expect(courseUser).not.toContain("{{");
    expect(courseUser).not.toContain("クッション値");
    expect(courseUser).not.toContain("min_starts");
    const raceBody = env.geminiBodies[1] as {
      systemInstruction?: { parts?: Array<{ text?: string }> };
      generationConfig?: unknown;
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const raceUser = raceBody.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(raceBody.systemInstruction?.parts?.[0]?.text).toBe("予測システム");
    expect(raceBody.generationConfig).toBeUndefined();
    expect(raceUser).toContain("# 馬柱");
    expect(raceUser).toContain("2026-10-12");
    expect(raceUser).toContain("通過3-3-2-2");
    expect(raceUser).toContain("着差0.2秒");
    expect(raceUser).toContain("コースは先行が残る");
    expect(raceUser).toContain("曇");
    expect(raceUser).toContain("重");
    expect(raceUser).toContain("クッション値9.2");
    expect(raceUser).toContain("ゴール前10.1");
    expect(raceUser).not.toContain("min_starts");
    expect(raceUser).not.toContain("{{");
    const created = env.notionCalls.find((call) => call.method === "POST" && call.path === "/v1/pages");
    const createdBody = created?.body as {
      properties?: { 名前?: { title?: Array<{ text?: { content?: string } }> } };
      children?: Array<{ type?: string; paragraph?: { color?: string; rich_text?: Array<{ text?: { content?: string } }> } }>;
    };
    expect(createdBody.properties?.名前?.title?.[0]?.text?.content).toBe("テストS（G2）");
    const children = createdBody.children;
    expect(children?.[0]?.type).toBe("heading_3");
    expect(JSON.stringify(children?.[0])).toContain("レース情報");
    expect(children?.some((block) => block.type === "heading_3")).toBe(true);
    expect(children?.some((block) => block.type === "bulleted_list_item")).toBe(true);
    const footer = children?.at(-1);
    expect(footer?.type).toBe("paragraph");
    expect(footer?.paragraph?.color).toBe("gray");
    expect(footer?.paragraph?.rich_text?.[0]?.text?.content).toContain("プロンプト版");
    const bodyText = JSON.stringify(children);
    expect(bodyText).toContain("指定モデル（course）: gemini-flash-latest");
    expect(bodyText).toContain("応答モデル modelVersion（course）: gemini-course-001");
    expect(bodyText).toContain("応答モデル modelVersion（race）: gemini-race-001");
    expect(bodyText).toContain("プロンプト版（course）: v1");
    expect(bodyText).toContain("先行有利");
    expect(bodyText).toContain("オッズ種別: 最終");
    expect(bodyText).toContain("2026-11-07T15:04:00+09:00");
    expect(bodyText).toContain("course_variant: null");
    await expect(env.kv.get(keys.notionPage(race.raceKey))).resolves.toBe("page-1");
    expect(env.notionCalls.some((call) => call.method === "DELETE")).toBe(false);

    const again = await drain(env, { kind: "start", runId: "run-2", race, requestedBy: "Muse" });
    expect(again.every((result) => result === "ack")).toBe(true);
    const creates = env.notionCalls.filter((call) => call.method === "POST" && call.path === "/v1/pages");
    expect(creates).toHaveLength(2);
    const second = creates[1]?.body as {
      properties?: { 名前?: { title?: Array<{ text?: { content?: string } }> } };
      children?: Array<{ type?: string; paragraph?: { color?: string } }>;
    };
    expect(second.properties?.名前?.title?.[0]?.text?.content).toBe("テストS（G2）");
    expect(second.children?.[0]?.type).toBe("heading_3");
    expect(second.children?.at(-1)?.paragraph?.color).toBe("gray");
    const archiveIndex = env.notionCalls.findIndex((call) => call.method === "PATCH" && call.path === "/v1/pages/page-1");
    const secondCreateIndex = env.notionCalls.lastIndexOf(creates[1]!);
    expect(archiveIndex).toBeGreaterThan(secondCreateIndex);
    expect(env.notionCalls[archiveIndex]?.body).toEqual({ archived: true });
    expect(env.archivedIds.has("page-1")).toBe(true);
    expect(env.archivedIds.has("page-2")).toBe(false);
    expect(env.notionCalls.some((call) => call.method === "DELETE")).toBe(false);
    expect(env.notionCalls.some((call) => call.path.includes("dify"))).toBe(true);
    await expect(env.kv.get(keys.notionPage(race.raceKey))).resolves.toBe("page-2");
  });

  it("fills legacy Dify user tokens through the predict step", async () => {
    const env = harness();
    await seedPrompts(env.kv, "dify");
    const results = await drain(env, { kind: "start", runId: "run-dify-tokens", race, requestedBy: "Grok Bot" });
    expect(results.every((result) => result === "ack")).toBe(true);
    const texts = env.geminiBodies.map((body) => {
      const contents = body.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined;
      return contents?.[0]?.parts?.[0]?.text ?? "";
    });
    expect(texts[0]).toContain("福島");
    expect(texts[0]).toContain("芝");
    expect(texts[0]).toContain("1600");
    expect(texts[0]).not.toContain("{{");
    expect(texts[1]).toContain("# 馬柱");
    expect(texts[1]).toContain("曇");
    expect(texts[1]).toContain("重");
    expect(texts[1]).toContain("クッション値9.2");
    expect(texts[1]).not.toContain("{{");
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
    await seedPrompts(env.kv);
    const results = await drain(env, { kind: "start", runId: "run-amb", race, requestedBy: "Muse" });
    expect(results.at(-1)).toBe("ack");
    expect(env.notionCalls.some((call) => call.method === "POST" && call.path === "/v1/pages")).toBe(false);
    const job = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as { phase?: string; error?: string };
    expect(job.phase).toBe("error");
    expect(job.error).toContain("複数");
  });

  it("continues when odds cannot be fetched", async () => {
    const env = harness({ odds: "error" });
    await seedPrompts(env.kv);
    await drain(env, { kind: "start", runId: "run-odds", race, requestedBy: "Grok Bot" });
    const created = env.notionCalls.find((call) => call.method === "POST" && call.path === "/v1/pages");
    expect(JSON.stringify(created?.body)).toContain("取得エラー");
  });

  it("retries an archive failure without dropping the old page or creating another", async () => {
    const env = harness({ existingPageId: "page-0", failArchiveOnce: true });
    await env.kv.put(keys.notionPage(race.raceKey), "page-0");
    await env.kv.put(keys.job(race.raceKey), JSON.stringify(notionReady()));
    const message: JobMessage = { kind: "notion", runId: "run-notion", raceKey: race.raceKey };
    const first = await handleJobMessage(message, env.deps, { attempt: 1, maxRetries: QUEUE_MAX_RETRIES });
    expect(first).toBe("retry");
    const midway = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(midway.phase).toBe("notion");
    expect(midway.error).toBeUndefined();
    expect(midway.notionPageId).toBe("page-1");
    expect(midway.notionArchivePageId).toBe("page-0");
    expect(env.archivedIds.has("page-0")).toBe(false);
    expect(env.createdIds).toEqual(["page-1"]);
    await expect(env.kv.get(keys.notionPage(race.raceKey))).resolves.toBe("page-1");

    const second = await handleJobMessage(message, env.deps, { attempt: 2, maxRetries: QUEUE_MAX_RETRIES });
    expect(second).toBe("ack");
    const done = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(done.phase).toBe("done");
    expect(done.notionPageId).toBe("page-1");
    expect(env.createdIds).toEqual(["page-1"]);
    expect(env.archivedIds.has("page-0")).toBe(true);
    expect(env.notionCalls.some((call) => call.method === "DELETE")).toBe(false);
    const archive = env.notionCalls.filter((call) => call.method === "PATCH" && call.path === "/v1/pages/page-0");
    expect(archive.at(-1)?.body).toEqual({ archived: true });
  });

  it("continues a budget split on a new message instead of stopping at phase=error", async () => {
    const lines = Array.from({ length: 130 }, (_, index) => `- 行${index}`).join("\n");
    const ready = notionReady();
    ready.prediction = { ...ready.prediction!, 予想本文: lines };
    const expected = pageBlocks({
      race,
      raceName: "テストS",
      requestedBy: ready.requestedBy,
      odds: ready.odds!,
      courseModel: ready.prediction.courseModel,
      raceModel: ready.prediction.raceModel,
      courseModelVersion: ready.prediction.courseModelVersion,
      raceModelVersion: ready.prediction.raceModelVersion,
      coursePromptVersion: ready.prediction.coursePromptVersion,
      racePromptVersion: ready.prediction.racePromptVersion,
      印: ready.prediction.印,
      予想本文: ready.prediction.予想本文,
      courseText: ready.prediction.courseText,
    });
    expect(expected.length).toBeGreaterThan(100);
    const env = harness({ existingPageId: "page-0", externalBudget: 6 });
    await env.kv.put(keys.notionPage(race.raceKey), "page-0");
    await env.kv.put(keys.job(race.raceKey), JSON.stringify(ready));
    const first = await handleJobMessage(
      { kind: "notion", runId: "run-notion", raceKey: race.raceKey },
      env.deps,
      { attempt: QUEUE_MAX_RETRIES, maxRetries: QUEUE_MAX_RETRIES },
    );
    expect(first).toBe("ack");
    const midway = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(midway.phase).toBe("notion");
    expect(midway.error).toBeUndefined();
    expect(midway.notionPageId).toBe("page-1");
    expect(midway.notionBlocksWritten).toBe(100);
    expect(midway.notionContinuations).toBe(1);
    expect(env.archivedIds.has("page-0")).toBe(false);
    expect(env.pending.map((message) => message.kind)).toEqual(["notion"]);
    const created = env.notionCalls.find((call) => call.method === "POST" && call.path === "/v1/pages");
    const createdChildren = (created?.body as { children?: unknown[] } | undefined)?.children ?? [];
    expect(createdChildren).toHaveLength(100);
    expect(JSON.stringify(createdChildren[99])).toBe(JSON.stringify(expected[99]));

    const second = await handleJobMessage(env.pending[0]!, env.deps, { attempt: 1, maxRetries: QUEUE_MAX_RETRIES });
    expect(second).toBe("ack");
    const done = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(done.phase).toBe("done");
    expect(done.notionPageId).toBe("page-1");
    expect(env.createdIds).toEqual(["page-1"]);
    expect(env.archivedIds.has("page-0")).toBe(true);
    const appended = env.notionCalls
      .filter((call) => call.method === "PATCH" && call.path === "/v1/blocks/page-1/children")
      .flatMap((call) => ((call.body as { children?: unknown[] } | undefined)?.children ?? []));
    expect(appended).toHaveLength(expected.length - 100);
    expect(JSON.stringify(appended[0])).toBe(JSON.stringify(expected[100]));
    expect(JSON.stringify(appended.at(-1))).toBe(JSON.stringify(expected.at(-1)));
    expect((appended.at(-1) as { paragraph?: { color?: string } }).paragraph?.color).toBe("gray");
    const archiveAt = env.notionCalls.findIndex((call) => call.method === "PATCH" && call.path === "/v1/pages/page-0" && (call.body as { archived?: boolean }).archived);
    const appendAt = env.notionCalls.findIndex((call) => call.method === "PATCH" && call.path === "/v1/blocks/page-1/children");
    expect(archiveAt).toBeGreaterThan(appendAt);
    expect(env.notionCalls.some((call) => call.method === "DELETE")).toBe(false);
    await expect(env.kv.get(keys.notionPage(race.raceKey))).resolves.toBe("page-1");
  });

  it("stops a budget split that never finishes instead of enqueueing forever", async () => {
    const env = harness({ externalBudget: 0 });
    const ready = notionReady({
      notionPageId: "page-1",
      notionArchivePageId: "page-0",
      notionBlocksWritten: 1,
      notionContinuations: NOTION_CONTINUATION_LIMIT,
    });
    await env.kv.put(keys.job(race.raceKey), JSON.stringify(ready));
    const decision = await handleJobMessage(
      { kind: "notion", runId: "run-notion", raceKey: race.raceKey },
      env.deps,
      { attempt: QUEUE_MAX_RETRIES, maxRetries: QUEUE_MAX_RETRIES },
    );
    expect(decision).toBe("ack");
    expect(env.pending).toHaveLength(0);
    const job = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(job.phase).toBe("error");
    expect(job.error).toContain("サブリクエスト");
    expect(env.notionCalls).toHaveLength(0);
  });

  it("requeries a same-name horse by birth year, keeps an unresolved note, and warns without blocking Notion", async () => {
    const raceText = [
      "### レース総合判定",
      "- **指数分布ステータス:** 【1強・独走型】",
      "- **予想自信度:** 【A】 （差がある）",
      "- **波乱度:** 【堅実】 （順当）",
      "",
      "### 競馬新聞風印予想",
      "- ◎ 1 ミラージュナイト",
      "",
      "ミラージュナイトは目黒記念で2着。今回斤量 55 kg。",
    ].join("\n");
    const env = harness({
      raceText,
      onEntries(args) {
        const name = (args.filters as { horse_name?: string } | undefined)?.horse_name;
        if (!name) {
          return {
            ok: true,
            data: {
              rows: [
                {
                  horse_number: 1,
                  horse_name: "ミラージュナイト",
                  birth_date: "2022-03-30T00:00:00Z",
                  weight_to_carry_kg: 57,
                  career_starts: 12,
                  prev_official_result: 1,
                  prev_distance: 2600,
                  prev_surface: "芝",
                  days_since_last_race: 105,
                  jockey_name: "騎手A",
                  sire_name: "父一",
                  broodmare_sire_name: "母父一",
                },
                {
                  horse_number: 2,
                  horse_name: "マイネルエンペラー",
                  birth_date: "2020-03-13T00:00:00Z",
                  weight_to_carry_kg: 58.5,
                  career_starts: 26,
                  prev_official_result: 2,
                  prev_distance: 2400,
                  prev_surface: "芝",
                  days_since_last_race: 35,
                  jockey_name: "騎手B",
                  sire_name: "父二",
                  broodmare_sire_name: "母父二",
                },
                {
                  horse_number: 3,
                  horse_name: "ゴースト",
                  birth_date: "2018-01-01",
                  weight_to_carry_kg: 56,
                  career_starts: 11,
                  prev_official_result: 5,
                  prev_distance: 1800,
                  prev_surface: "ダート",
                  days_since_last_race: 21,
                  jockey_name: "騎手C",
                  sire_name: "父三",
                  broodmare_sire_name: "母父三",
                },
              ],
            },
          };
        }
        if (name === "マイネルエンペラー" || name === "ゴースト") {
          return {
            ok: true,
            data: {
              row_count: 0,
              rows: [],
              name_resolution: [
                {
                  field: "horse_name",
                  query: name,
                  status: "ambiguous",
                  candidates: [
                    { name: `${name} (2020)`, starts: 26, period: "2022〜2026" },
                    { name: `${name} (1993)`, starts: 99, period: "1995〜1996" },
                  ],
                },
              ],
            },
          };
        }
        if (name === "マイネルエンペラー (2020)") {
          return {
            ok: true,
            data: {
              name_resolution: [{ field: "horse_name", query: name, status: "resolved", candidates: [{ name, starts: 26 }] }],
              rows: [
                {
                  horse_name: "マイネルエンペラー",
                  race_meeting_date: "2026-10-04",
                  race_track: "京都",
                  race_number: 11,
                  surface: "芝",
                  distance: 2400,
                  race_name_main: "京都大賞典",
                  official_result: 2,
                  entry_status: "finished",
                },
              ],
            },
          };
        }
        if (name === "ミラージュナイト") {
          return {
            ok: true,
            data: {
              rows: [
                {
                  horse_name: "ミラージュナイト",
                  race_meeting_date: "2026-05-31",
                  race_track: "東京",
                  race_number: 11,
                  surface: "芝",
                  distance: 2500,
                  race_name_main: "目黒記念",
                  official_result: 4,
                  entry_status: "finished",
                },
              ],
            },
          };
        }
        return { ok: true, data: { rows: [] } };
      },
    });
    await seedPrompts(env.kv);
    const logs: string[] = [];
    env.deps.log = (event) => {
      logs.push(event);
    };
    const results = await drain(env, { kind: "start", runId: "run-same", race, requestedBy: "Grok Bot" });
    expect(results.every((result) => result === "ack")).toBe(true);
    const queried = env.entryCalls.map((args) => (args.filters as { horse_name?: string }).horse_name ?? "(card)");
    expect(queried).toContain("マイネルエンペラー");
    expect(queried).toContain("マイネルエンペラー (2020)");
    expect(queried.filter((name) => name.startsWith("ゴースト"))).toEqual(["ゴースト"]);
    const job = JSON.parse((await env.kv.get(keys.job(race.raceKey))) ?? "{}") as JobState;
    expect(job.phase).toBe("done");
    const emperor = job.formTasks.find((task) => task.horseName === "マイネルエンペラー");
    expect(emperor?.resolution).toMatchObject({ status: "resolved_by_birth_year", resolvedName: "マイネルエンペラー (2020)", birthYear: 2020 });
    expect(emperor?.rows).toHaveLength(1);
    const ghost = job.formTasks.find((task) => task.horseName === "ゴースト");
    expect(ghost?.resolution?.status).toBe("unresolved");
    expect(ghost?.rows).toEqual([]);
    expect(ghost?.note).toContain("同名馬のため近走取得不可");
    expect(ghost?.note).toContain("通算出走数 11");
    expect(ghost?.note).not.toContain("近走は空");
    const prompt = (env.geminiBodies[1]?.contents as Array<{ parts?: Array<{ text?: string }> }>)[0]?.parts?.[0]?.text ?? "";
    expect(prompt).toContain("京都大賞典");
    expect(prompt).toContain("同名馬のため近走取得不可");
    expect(prompt).toContain("通算出走数 11");
    expect(prompt).not.toMatch(/ゴースト[\s\S]{0,80}近走なし/);
    const stored = await loadPredictInput(env.kv, race.raceKey);
    expect(stored?.umabashira).toContain("目黒記念");
    expect(stored?.raceInput).toBe(prompt);
    expect(stored?.horses.find((horse) => horse.horseName === "ミラージュナイト")?.pastRuns[0]).toMatchObject({
      raceName: "目黒記念",
      officialResult: 4,
    });
    expect(job.consistencyWarnings?.map((warning) => warning.message)).toEqual([
      "ミラージュナイトの目黒記念は4着だが、予想本文は2着と書いている",
      "ミラージュナイトの今回斤量は57kgだが、予想本文は55kgと書いている",
    ]);
    expect(logs).toContain("prediction_consistency");
    const notion = JSON.stringify(env.notionCalls);
    expect(notion).not.toContain("予想本文は");
    expect(notion).not.toContain("同名馬のため近走取得不可");
    expect(job.phase).toBe("done");
  });
});

function notionReady(extra: Partial<JobState> = {}): JobState {
  return {
    runId: "run-notion",
    race,
    requestedBy: "Grok Bot",
    phase: "notion",
    remarks: "",
    baba: null,
    raceRow: { race_name_main: "テストS", grade: "G2" },
    entries: [],
    formTasks: [],
    odds: {
      source: "none",
      available: false,
      kind: null,
      observedAtJst: null,
      reason: "未発売",
      detail: null,
      horses: [],
    },
    courseVariant: null,
    statTasks: [],
    prediction: {
      courseText: "コースは先行が残る",
      courseModel: "gemini-flash-latest",
      raceModel: "gemini-flash-latest",
      courseModelVersion: "gemini-course-001",
      raceModelVersion: "gemini-race-001",
      coursePromptVersion: "v1",
      racePromptVersion: "v1",
      指数分布: "【1強・独走型】",
      自信度: "【A】",
      波乱度: "【堅実】",
      印: "◎ 1 ア",
      予想本文: "### レース情報\n- 先行有利",
    },
    notionPageId: null,
    updatedAt: "2026-11-07T06:00:00.000Z",
    ...extra,
  };
}
