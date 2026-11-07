import { readFileSync } from "node:fs";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { identifyCaller, verifyAccessJwt } from "../src/access";
import { ExternalBudget, budgetedFetch } from "../src/budget";
import { cronSkipReason } from "../src/cron";
import { decryptJson, encryptJson, importAesKey, safeEqual } from "../src/crypto-util";
import { composeRemarks, fillCourseUser, fillRaceUser, mergeGoing } from "../src/dify-input";
import { extractRaceMarkdown } from "../src/extract-prediction";
import { PAST_RUN_LIMIT, selectPastRuns } from "../src/form";
import { parseRacePrediction } from "../src/gemini";
import { formatJst } from "../src/jst";
import { keys, MemoryKv } from "../src/kv";
import { loadPrompt } from "../src/prompts";
import { formatPastRun, renderUmabashira } from "../src/umabashira";
import { applyModelUpdate, assertModelsAllowed, generateContentModels, restoreModelUpdate } from "../src/models";
import { ambiguousNameMessage, parseMcpHttpBody, unwrapToolResult } from "../src/bashira/mcp";
import { applyTokenResponse, buildAuthorizeUrl, createPkce, discoverOAuth } from "../src/bashira/oauth";
import { footerLines, pageBlocks, pageTitle } from "../src/body";
import { markdownToNotionBlocks, chunkChildren } from "../src/notion-blocks";
import { blocksIncludeBashira, decideNotionTarget } from "../src/notion";
import { interpretOdds } from "../src/odds";
import { parseRaceRequest } from "../src/race-ref";
import { rowsToObjects } from "../src/rows";
import { assertToolArgs, catalogFromTools } from "../src/schema";
import { CORNER_RANGES, buildStatTasks, yearFrom } from "../src/stats";
import { JobError } from "../src/types";
import { bashiraTools } from "./fixture";

const catalog = catalogFromTools(bashiraTools);

describe("race ref", () => {
  it("reads a BASHIRA race id", () => {
    const race = parseRaceRequest({ race_id: "20261107-03-11" });
    expect(race).toMatchObject({ date: "2026-11-07", venue: "福島", venueCode: "03", raceNumber: 11, raceKey: "20261107-03-11" });
  });

  it("reads date, venue, and race number", () => {
    const race = parseRaceRequest({ date: "2026-11-07", venue: "福島競馬場", race_number: 11 });
    expect(race.raceId).toBe("20261107-03-11");
  });

  it("rejects conflicting identifiers and extra races", () => {
    expect(() => parseRaceRequest({ race_id: "20261107-03-11", venue: "東京", date: "2026-11-07", race_number: 11 })).toThrow(JobError);
    expect(() => parseRaceRequest({ races: [] })).toThrow(/1 レース/);
    expect(() => parseRaceRequest({ race_number: 13, date: "2026-11-07", venue: "福島" })).toThrow(/1〜12/);
  });
});

describe("odds", () => {
  const now = new Date("2026-11-07T06:00:00Z");

  it("records kind and JST time when odds exist", () => {
    const summary = interpretOdds({
      now,
      entryRows: [],
      getOdds: {
        ok: true,
        payload: {
          columns: ["selection", "odds", "status", "odds_kind", "odds_observed_at"],
          rows: [
            ["1", 2.4, null, "最終", "2026-11-07T06:04:00Z"],
            ["2", null, "no_bets", "最終", "2026-11-07T06:04:00Z"],
          ],
        },
      },
    });
    expect(summary.available).toBe(true);
    expect(summary.kind).toBe("最終");
    expect(summary.observedAtJst).toBe("2026-11-07T15:04:00+09:00");
    expect(summary.horses[0]).toMatchObject({ horseNumber: 1, odds: 2.4 });
  });

  it("continues with 未発売, 発売票数なし, or 取得エラー", () => {
    const unsold = interpretOdds({
      now,
      entryRows: [],
      getOdds: { ok: true, payload: { rows: [], live_as_of: "2026-11-07T05:50:00Z" } },
    });
    expect(unsold.reason).toBe("未発売");
    expect(unsold.kind).toBeNull();
    expect(unsold.observedAtJst).toBeNull();

    const noBets = interpretOdds({
      now,
      entryRows: [],
      getOdds: {
        ok: true,
        payload: { rows: [{ selection: "1", odds: null, status: "no_bets", odds_kind: "デフォルト", odds_observed_at: "2026-11-07T06:04:00Z" }] },
      },
    });
    expect(noBets.reason).toBe("発売票数なし");
    expect(noBets.kind).toBe("デフォルト");
    expect(noBets.observedAtJst).toBe("2026-11-07T15:04:00+09:00");

    const failed = interpretOdds({
      now,
      entryRows: [{ horse_number: 1, win_odds: null }],
      getOdds: { ok: false, message: "timeout" },
    });
    expect(failed.reason).toBe("取得エラー");

    const fallback = interpretOdds({
      now,
      entryRows: [{ horse_number: 1, win_odds: 4.2, odds_kind: "前日最終", odds_observed_at: "2026-11-06T07:00:00Z" }],
      getOdds: { ok: false, message: "timeout" },
    });
    expect(fallback.source).toBe("entries");
    expect(fallback.available).toBe(true);
    expect(fallback.kind).toBe("前日最終");
  });
});

describe("rows and jst", () => {
  it("accepts columnar and object rows", () => {
    expect(rowsToObjects({ columns: ["a"], rows: [[1]] })).toEqual([{ a: 1 }]);
    expect(rowsToObjects({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });

  it("formats JST", () => {
    expect(formatJst("2026-11-07T06:04:00Z")).toBe("2026-11-07T15:04:00+09:00");
    expect(formatJst("not-a-date")).toBeNull();
  });
});

describe("stats tasks", () => {
  const tasks = buildStatTasks(
    {
      venue: "福島",
      surface: "芝",
      distance: 1600,
      yearFrom: yearFrom(2026, 5),
      minStarts: 30,
      broodmareMinStarts: 50,
      sires: ["父一", "父二"],
      broodmareSires: ["母父一"],
      jockeys: ["騎手A", "騎手B"],
    },
    catalog,
  );

  it("builds one call per corner range and per jockey, with v2 cache keys", () => {
    expect(yearFrom(2026, 5)).toBe(2022);
    expect(tasks.filter((task) => task.kind === "corner")).toHaveLength(CORNER_RANGES.length);
    expect(tasks.filter((task) => task.kind === "jockey")).toHaveLength(2);
    expect(tasks.find((task) => task.kind === "bracket")?.args).toMatchObject({
      dimensions: ["bracket_number"],
      min_starts: 30,
      filters: { race_track: "福島", surface: "芝", distance: 1600, race_year: { gte: 2022 } },
    });
    expect(tasks.find((task) => task.kind === "broodmare_sire")?.args).toMatchObject({ min_starts: 50 });
    expect(tasks.every((task) => task.cacheKey.startsWith("stats:v2:"))).toBe(true);
    expect(JSON.stringify(tasks)).not.toContain("win_odds_rank");
    expect(tasks.map((task) => task.id)).toContain("corner:11plus");
  });

  it("stops when the live schema lacks a field", () => {
    const narrow = catalogFromTools([
      toolLike("get_stats", ["filters"], ["race_track"]),
    ]);
    expect(() =>
      buildStatTasks(
        {
          venue: "福島",
          surface: "芝",
          distance: 1600,
          yearFrom: 2022,
          minStarts: 30,
          broodmareMinStarts: 50,
          sires: [],
          broodmareSires: [],
          jockeys: [],
        },
        narrow,
      ),
    ).toThrow(/推測では呼びません/);
  });
});

describe("schema", () => {
  it("rejects arguments that are not in tools/list", () => {
    expect(() => assertToolArgs(catalog, "get_odds", { race_id: "20261107-03-11", bet_type: "win", extra: 1 })).toThrow(/extra/);
  });
});

describe("mcp", () => {
  it("parses SSE and tool text", () => {
    const message = parseMcpHttpBody("text/event-stream", 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(message.result).toEqual({ ok: true });
    expect(unwrapToolResult({ content: [{ type: "text", text: '{"rows":[]}' }] })).toEqual({ rows: [] });
    expect(() => unwrapToolResult({ isError: true, content: [{ type: "text", text: "nope" }] })).toThrow(/nope/);
  });

  it("flags unresolved name candidates and ignores a resolved name", () => {
    expect(ambiguousNameMessage({ name_resolution: { jockey_name: { candidates: [{ name: "A" }, { name: "B" }] } } })).toMatch(/曖昧/);
    expect(ambiguousNameMessage({ name_resolution: { jockey_name: { candidates: [{ name: "A" }, { name: "B" }], resolved: { name: "A" } } } })).toBeNull();
  });
});

describe("oauth tokens", () => {
  it("discovers metadata and rotates refresh tokens only when a new one arrives", async () => {
    const metadata = await discoverOAuth("https://mcp.bashira.omninode.co.jp/mcp", async (url) => {
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return Response.json({ resource: "https://mcp.bashira.omninode.co.jp/mcp", authorization_servers: ["https://mcp.bashira.omninode.co.jp/"] });
      }
      return Response.json({
        issuer: "https://mcp.bashira.omninode.co.jp/",
        authorization_endpoint: "https://mcp.bashira.omninode.co.jp/authorize",
        token_endpoint: "https://mcp.bashira.omninode.co.jp/token",
        registration_endpoint: "https://mcp.bashira.omninode.co.jp/register",
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    });
    expect(metadata.registration_endpoint).toContain("/register");
    const current = { accessToken: "old-access", refreshToken: "old-refresh", expiresAtMs: 1, needsReauth: false, lastError: null };
    const kept = applyTokenResponse(current, { access_token: "new-access" }, 1_000);
    expect(kept.refreshToken).toBe("old-refresh");
    expect(kept.expiresAtMs).toBe(1_000 + 5 * 60 * 1000);
    const rotated = applyTokenResponse(current, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 30 }, 1_000);
    expect(rotated.refreshToken).toBe("new-refresh");
    expect(rotated.expiresAtMs).toBe(31_000);
    const pkce = await createPkce();
    const url = new URL(buildAuthorizeUrl({ metadata, clientId: "cid", redirectUri: "https://worker.example/oauth/callback", state: pkce.state, codeChallenge: pkce.challenge }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(metadata.resource);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(pkce.challenge).toBe(challenge);
  });
});

describe("crypto", () => {
  it("round-trips tokens and compares state", async () => {
    const key = await importAesKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
    const packed = await encryptJson(key, { refreshToken: "secret" });
    expect(packed).not.toContain("secret");
    await expect(decryptJson(key, packed)).resolves.toEqual({ refreshToken: "secret" });
    expect(safeEqual("state", "state")).toBe(true);
    expect(safeEqual("state", "other")).toBe(false);
  });
});

describe("models", () => {
  it("filters generateContent models and restores the previous setting", () => {
    const models = generateContentModels({
      models: [
        { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    expect(models.map((model) => model.name)).toEqual(["gemini-flash-latest"]);
    const now = new Date("2026-11-07T06:00:00Z");
    const updated = applyModelUpdate({
      current: { course: "gemini-flash-latest", race: "gemini-flash-latest" },
      history: [],
      patch: { race: "models/gemini-pro-latest" },
      caller: "Muse",
      clientId: "muse-id",
      now,
    });
    expect(updated.current).toEqual({ course: "gemini-flash-latest", race: "gemini-pro-latest" });
    expect(updated.history[0]).toMatchObject({ caller: "Muse", client_id: "muse-id", at_jst: "2026-11-07T15:00:00+09:00" });
    expect(() => assertModelsAllowed(updated.current, new Set(["gemini-flash-latest"]))).toThrow(/race モデル/);
    const restored = restoreModelUpdate({
      current: updated.current,
      previous: updated.previous,
      history: updated.history,
      caller: "Grok Bot",
      clientId: "grok-id",
      now,
    });
    expect(restored.current.race).toBe("gemini-flash-latest");
    expect(restored.history.at(-1)?.restored).toBe(true);
  });
});

describe("notion matching", () => {
  it("creates beside a Dify page and refuses ambiguous BASHIRA pages", () => {
    expect(decideNotionTarget({ stored: null, pages: [{ id: "dify", isBashira: false }], truncated: false })).toEqual({ action: "create" });
    expect(decideNotionTarget({ stored: null, pages: [{ id: "ours", isBashira: true }], truncated: false })).toEqual({ action: "update", pageId: "ours" });
    expect(decideNotionTarget({ stored: null, pages: [{ id: "a", isBashira: true }, { id: "b", isBashira: true }], truncated: false }).action).toBe("error");
    expect(
      decideNotionTarget({
        stored: { id: "ours", found: true, matchesRace: false },
        pages: [],
        truncated: false,
      }).action,
    ).toBe("error");
    expect(decideNotionTarget({ stored: null, pages: [], truncated: true }).action).toBe("error");
    expect(blocksIncludeBashira([{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "BASHIRAで取得" }] } }])).toBe(true);
    expect(blocksIncludeBashira([{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Dify" }] } }])).toBe(false);
    expect(
      blocksIncludeBashira([
        { type: "heading_3", heading_3: { rich_text: [{ plain_text: "レース情報" }] } },
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "灰色 BASHIRAで取得 実行者" }] } },
      ]),
    ).toBe(true);
  });
});

describe("page title", () => {
  const race = { raceKey: "20261108-05-11", raceId: "20261108-05-11", date: "2026-11-08", venue: "東京", venueCode: "05", raceNumber: 11 };
  it("adds a grade in fullwidth parentheses and omits an empty grade", () => {
    expect(pageTitle(race, "アルゼンチン共和国杯", "G2")).toBe("アルゼンチン共和国杯（G2）");
    expect(pageTitle(race, "アルゼンチン共和国杯", null)).toBe("アルゼンチン共和国杯");
    expect(pageTitle(race, "アルゼンチン共和国杯", "平場")).toBe("アルゼンチン共和国杯");
    expect(pageTitle(race, "アルゼンチン共和国杯", "その他重賞")).toBe("アルゼンチン共和国杯");
    expect(pageTitle(race, "アルゼンチン共和国杯（G2）", "G2")).toBe("アルゼンチン共和国杯（G2）");
    expect(pageTitle(race, null, null)).toBe("東京11R");
    expect(pageTitle(race, "テストS", "G2")).not.toContain("【BASHIRA】");
  });
});

describe("page body", () => {
  const input = {
    race: { raceKey: "20261107-03-11", raceId: "20261107-03-11", date: "2026-11-07", venue: "福島", venueCode: "03", raceNumber: 11 },
    raceName: "テストS",
    requestedBy: "Grok Bot",
    odds: { source: "none" as const, available: false, kind: null, observedAtJst: null, reason: "未発売" as const, detail: null, horses: [] },
    courseModel: "gemini-flash-latest",
    raceModel: "gemini-flash-latest",
    courseModelVersion: "gemini-course-001",
    raceModelVersion: null,
    coursePromptVersion: "3",
    racePromptVersion: "4",
    印: "◎1",
    予想本文: "本文",
    courseText: "分析",
  };

  it("renders markdown blocks and puts system info in a gray footer", () => {
    const blocks = pageBlocks(input);
    expect(JSON.stringify(blocks[0])).not.toContain("BASHIRAで取得");
    expect(blocks.some((block) => block.type === "heading_3")).toBe(true);
    expect(blocks.some((block) => block.type === "bulleted_list_item")).toBe(true);
    const dividerAt = blocks.findIndex((block) => block.type === "divider");
    expect(dividerAt).toBeGreaterThan(0);
    const footer = blocks.slice(dividerAt + 1);
    expect(footer.length).toBeGreaterThan(0);
    expect(footer.every((block) => (block.paragraph as { color?: string } | undefined)?.color === "gray")).toBe(true);
    const footerText = JSON.stringify(footer);
    expect(footerText).toContain("BASHIRAで取得");
    expect(footerText).toContain("course_variant: null");
    expect(footerText).toContain("指定モデル（course）: gemini-flash-latest");
    expect(footerText).toContain("応答モデル modelVersion（race）: 応答に modelVersion が無い");
    expect(footerText).toContain("プロンプト版（course）: 3");
    expect(footerText).toContain("オッズ種別: なし");
    expect(footerText).toContain("未発売");
    expect(JSON.stringify(blocks)).toContain("◎1");
    expect(footerLines(input)[0]).toContain("BASHIRAで取得");
  });
});

describe("dify markdown blocks", () => {
  it("maps headings, bold bullets, dividers, and code the way the Dify node does", () => {
    const blocks = markdownToNotionBlocks(
      [
        "### レース情報",
        "- **日付:** 2026-11-08",
        "- **開催場:** 東京",
        "",
        "### 競馬新聞風印予想",
        "- ◎ 7 サンプル",
        "",
        "---",
        "## 二次（深掘り）",
        "#### 7 サンプル",
        "```json",
        "{\"a\":1}",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_3",
      "bulleted_list_item",
      "bulleted_list_item",
      "heading_3",
      "bulleted_list_item",
      "divider",
      "heading_2",
      "heading_4",
      "code",
    ]);
    const bullet = blocks[1]?.bulleted_list_item as { rich_text: Array<{ text: { content: string }; annotations?: { bold?: boolean } }> };
    expect(bullet.rich_text[0]?.text.content).toBe("日付:");
    expect(bullet.rich_text[0]?.annotations?.bold).toBe(true);
    expect(bullet.rich_text[1]?.text.content).toBe(" 2026-11-08");
    const code = blocks.at(-1)?.code as { language: string; rich_text: Array<{ text: { content: string } }> };
    expect(code.language).toBe("json");
    expect(code.rich_text[0]?.text.content).toBe('{"a":1}');
  });

  it("merges consecutive blockquotes into one callout and keeps bold", () => {
    const blocks = markdownToNotionBlocks(
      [
        "> **【指数サマリー】** 最高指数: 89点",
        "> 1-2位差: 2点",
        "",
        "> 別の注記",
        "本文",
        "```",
        "> コードの中",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["callout", "callout", "paragraph", "code"]);
    const callout = blocks[0]?.callout as {
      color: string;
      icon: { type: string; emoji: string };
      rich_text: Array<{ text: { content: string }; annotations?: { bold?: boolean } }>;
    };
    expect(callout.icon).toEqual({ type: "emoji", emoji: "💡" });
    expect(callout.color).toBe("gray_background");
    expect(callout.rich_text[0]?.text.content).toBe("【指数サマリー】");
    expect(callout.rich_text[0]?.annotations?.bold).toBe(true);
    expect(callout.rich_text[1]?.text.content).toBe(" 最高指数: 89点\n1-2位差: 2点");
    const second = blocks[1]?.callout as { rich_text: Array<{ text: { content: string } }> };
    expect(second.rich_text[0]?.text.content).toBe("別の注記");
    const code = blocks.at(-1)?.code as { rich_text: Array<{ text: { content: string } }> };
    expect(code.rich_text[0]?.text.content).toBe("> コードの中");
  });

  it("caps callout rich text at 2000 characters", () => {
    const blocks = markdownToNotionBlocks(`> ${"あ".repeat(2001)}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("callout");
    const rich = (blocks[0]?.callout as { rich_text: Array<{ text: { content: string } }> }).rich_text;
    expect(rich.map((part) => [...part.text.content].length)).toEqual([2000, 1]);
  });

  it("splits rich text at 2000 characters and children into chunks of 100", () => {
    const blocks = markdownToNotionBlocks(`x${"あ".repeat(2000)}`);
    const rich = (blocks[0]?.paragraph as { rich_text: Array<{ text: { content: string } }> }).rich_text;
    expect(rich).toHaveLength(2);
    expect([...rich[0]!.text.content].length).toBe(2000);
    expect(rich[1]!.text.content).toBe("あ");
    const many = markdownToNotionBlocks(Array.from({ length: 101 }, (_, index) => `行${index}`).join("\n"));
    const chunks = chunkChildren(many);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 1]);
  });
});

describe("dify v1 inputs", () => {
  const race = { raceKey: "20261107-03-11", raceId: "20261107-03-11", date: "2026-11-07", venue: "福島", venueCode: "03", raceNumber: 11 };

  it("keeps the Dify race prompt text and leaves stats out of the course prompt", () => {
    const system = readFileSync("prompts/v1/race_system.md", "utf8");
    const user = readFileSync("prompts/v1/race_user.md", "utf8");
    const courseSystem = readFileSync("prompts/v1/course_system.md", "utf8");
    const courseUser = readFileSync("prompts/v1/course_user.md", "utf8");
    expect(system.startsWith("# あなたの役割と目的")).toBe(true);
    expect(user).toContain("{{#1788721223615.output#}}");
    expect(user).toContain("{{#1788103991048.weathre#}}");
    expect(user).not.toContain("get_stats");
    expect(courseSystem.startsWith("# 役割と目的")).toBe(true);
    expect(courseSystem).not.toContain("地方競馬");
    expect(courseUser).toContain("{{#1788717846587.course#}}");
    expect(courseUser).toContain("{{#1788717846587.type#}} {{#1788717846587.distance#}}");
    expect(courseUser).not.toContain("get_stats");
  });

  it("fills only the Dify user slots", () => {
    const filled = fillRaceUser(readFileSync("prompts/v1/race_user.md", "utf8"), {
      umabashira: "馬柱本文",
      course: "コース本文",
      weather: "晴",
      condition: "良",
      remarks: "なし",
    });
    expect(filled).toContain("馬柱本文");
    expect(filled).toContain("コース本文");
    expect(filled).not.toContain("{{#");
    expect(filled).not.toContain("min_starts");
    const course = fillCourseUser(readFileSync("prompts/v1/course_user.md", "utf8"), {
      course: "福島",
      type: "芝",
      distance: "1600",
    });
    expect(course).toContain("競馬場: 福島");
    expect(course).toContain("芝 1600");
    expect(course).not.toContain("{{#");
    expect(course).not.toContain("min_starts");
  });

  it("lets BASHIRA weather and going override baba, and keeps cushion and moisture", () => {
    const merged = mergeGoing({
      surface: "芝",
      raceRow: { weather: "曇", track_condition: "重" },
      baba: {
        venue: {
          weather: "晴",
          cushion: 9.2,
          measuredAt: "11月7日 7時00分",
          rainfallMm: 0,
          turf: { condition: "良", goal: 10.1, corner4: 11.2, goalCondition: "良", corner4Condition: "良" },
          dirt: { condition: "稍重", goal: 8, corner4: 8.4 },
          usedCourse: "Bコース",
        },
      },
    });
    expect(merged.weather).toBe("曇");
    expect(merged.condition).toBe("重");
    expect(merged.babaDetail).toContain("クッション値9.2");
    expect(merged.babaDetail).toContain("ゴール前10.1");
    expect(merged.babaDetail).toContain("使用コース:Bコース");
    const withoutBashira = mergeGoing({
      surface: "ダート",
      raceRow: {},
      baba: { venue: { dirt: { condition: "稍重", goal: 5, corner4: 6 } } },
    });
    expect(withoutBashira.condition).toBe("稍重");
    expect(withoutBashira.weather).toBe("不明");
    const remarks = composeRemarks("メモ", merged.babaDetail, race);
    expect(remarks.startsWith("メモ\n")).toBe(true);
    expect(remarks).toContain("2026-11-07 場:03 11R ｜");
    expect(remarks).toContain("クッション値9.2");
  });

  it("keeps at most ten past runs and skips the current race", () => {
    const rows = [
      { horse_name: "ア", race_meeting_date: "2026-11-07", race_track: "福島", race_number: 11, entry_status: "upcoming" },
      ...Array.from({ length: 12 }, (_, index) => ({
        horse_name: "ア",
        race_meeting_date: `2026-01-${String(index + 1).padStart(2, "0")}`,
        race_track: "東京",
        race_number: 1,
        entry_status: "finished",
        official_result: index + 1,
      })),
    ];
    const selected = selectPastRuns(rows, race, "ア");
    expect(selected).toHaveLength(PAST_RUN_LIMIT);
    expect(selected.some((row) => row.race_meeting_date === "2026-11-07")).toBe(false);
    expect(selected[0]?.race_meeting_date).toBe("2026-01-12");
  });

  it("renders a past run with the fields BASHIRA provides", () => {
    const line = formatPastRun({
      race_meeting_date: "2026-10-12",
      race_track: "東京",
      surface: "芝",
      distance: 1600,
      rail_type: "A",
      track_condition: "良",
      race_condition: "3勝クラス",
      race_name_main: "前走",
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
    });
    expect(line).toContain("2026-10-12");
    expect(line).toContain("東京芝1600m（A）");
    expect(line).toContain("2着");
    expect(line).toContain("頭数16");
    expect(line).toContain("時計1:33.2");
    expect(line).toContain("着差0.2秒");
    expect(line).toContain("通過3-3-2-2");
    expect(line).toContain("上り33.8(1位)");
    expect(line).toContain("騎手 騎手A");
    expect(line).toContain("斤量 56");
    expect(line).toContain("人気 4");
    const page = renderUmabashira({
      race,
      entries: [{ horse_number: 1, horse_name: "ア", race_abnormality: "出走取消" }],
      formTasks: [],
    });
    expect(page).toContain("馬身");
    expect(page).toContain("出走取消");
    expect(page).not.toContain("min_starts");
  });

  it("reads the Dify markdown headings and rejects the old prompt shape", async () => {
    const fields = extractRaceMarkdown(
      ["### レース総合判定", "- **指数分布ステータス:** 【1強・独走型】", "- **予想自信度:** 【A】", "- **波乱度:** 【堅実】", "", "### 競馬新聞風印予想", "- ◎ 1 ア"].join("\n"),
    );
    expect(fields).toMatchObject({ 指数分布: "1強・独走型", 自信度: "A", 波乱度: "堅実" });
    expect(fields.印).toContain("◎ 1 ア");
    const kv = new MemoryKv();
    await kv.put(keys.prompt("race"), JSON.stringify({ version: "1.0.0", text: "古い本文" }));
    await expect(loadPrompt(kv, "race")).rejects.toThrow(/system/);
  });
});

describe("gemini json", () => {
  it("reads a fenced race prediction", () => {
    expect(parseRacePrediction('```json\n{"指数分布":"1強","自信度":"A","波乱度":"堅実","印":"◎1","予想本文":"行く"}\n```')).toMatchObject({
      自信度: "A",
    });
  });
});

describe("access jwt", () => {
  it("checks signature, issuer, and audience, then labels the service token", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const issuer = "https://team.cloudflareaccess.com";
    const token = await new SignJWT({ common_name: "service: Muse" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience("aud-tag")
      .setExpirationTime("2h")
      .sign(privateKey);
    const payload = await verifyAccessJwt(token, { issuer, audience: "aud-tag", key: publicKey });
    expect(identifyCaller({ clientId: "muse-id", payload, grokClientId: "grok-id", museClientId: "muse-id" }).name).toBe("Muse");
    expect(identifyCaller({ clientId: null, payload, grokClientId: "", museClientId: "" }).name).toBe("Muse");
    const grok = identifyCaller({
      clientId: "grok-id",
      payload: { sub: "x" },
      grokClientId: "grok-id",
      museClientId: "muse-id",
    });
    expect(grok.name).toBe("Grok Bot");
    await expect(verifyAccessJwt(token, { issuer, audience: "other", key: publicKey })).rejects.toThrow();
  });
});

describe("budget and cron", () => {
  it("stops before the free-plan external subrequest cap", async () => {
    const budget = new ExternalBudget(2);
    const fetcher = async () => new Response("ok");
    await budgetedFetch(budget, "https://example.test/1", undefined, fetcher);
    await budgetedFetch(budget, "https://example.test/2", undefined, fetcher);
    await expect(budgetedFetch(budget, "https://example.test/3", undefined, fetcher)).rejects.toThrow(/50/);
  });

  it("does not enqueue races from cron", () => {
    expect(cronSkipReason()).toContain("何も積まない");
  });
});

describe("memory kv", () => {
  it("expires values", async () => {
    let now = 0;
    const kv = new MemoryKv(() => now);
    await kv.put("a", "1", { expirationTtl: 5 });
    now = 6000;
    await expect(kv.get("a")).resolves.toBeNull();
  });
});

function toolLike(name: string, args: string[], fields: string[]) {
  return {
    name,
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(args.map((arg) => [arg, { type: "string" }])),
        filters: { properties: Object.fromEntries(fields.map((field) => [field, {}])) },
      },
    },
  };
}
