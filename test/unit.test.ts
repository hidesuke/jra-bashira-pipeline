import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { identifyCaller, verifyAccessJwt } from "../src/access";
import { ExternalBudget, budgetedFetch } from "../src/budget";
import { cronSkipReason } from "../src/cron";
import { decryptJson, encryptJson, importAesKey, safeEqual } from "../src/crypto-util";
import { parseRacePrediction } from "../src/gemini";
import { formatJst } from "../src/jst";
import { MemoryKv } from "../src/kv";
import { applyModelUpdate, assertModelsAllowed, generateContentModels, restoreModelUpdate } from "../src/models";
import { ambiguousNameMessage, parseMcpHttpBody, unwrapToolResult } from "../src/bashira/mcp";
import { applyTokenResponse, buildAuthorizeUrl, createPkce, discoverOAuth } from "../src/bashira/oauth";
import { pageLines } from "../src/body";
import { decideNotionTarget, firstParagraphIsBashira } from "../src/notion";
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
    expect(firstParagraphIsBashira([{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "BASHIRAで取得" }] } }])).toBe(true);
    expect(firstParagraphIsBashira([{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Dify" }] } }])).toBe(false);
  });
});

describe("page body", () => {
  it("starts with the BASHIRA line and records models, versions, and odds", () => {
    const lines = pageLines({
      race: { raceKey: "20261107-03-11", raceId: "20261107-03-11", date: "2026-11-07", venue: "福島", venueCode: "03", raceNumber: 11 },
      raceName: "テストS",
      requestedBy: "Grok Bot",
      odds: { source: "none", available: false, kind: null, observedAtJst: null, reason: "未発売", detail: null, horses: [] },
      courseModel: "gemini-flash-latest",
      raceModel: "gemini-flash-latest",
      courseModelVersion: "gemini-course-001",
      raceModelVersion: null,
      coursePromptVersion: "3",
      racePromptVersion: "4",
      印: "◎1",
      予想本文: "本文",
      courseText: "分析",
    });
    expect(lines[0]).toBe("BASHIRAで取得");
    expect(lines.join("\n")).toContain("course_variant: null");
    expect(lines.join("\n")).toContain("指定モデル（course）: gemini-flash-latest");
    expect(lines.join("\n")).toContain("応答モデル modelVersion（race）: 応答に modelVersion が無い");
    expect(lines.join("\n")).toContain("プロンプト版（course）: 3");
    expect(lines.join("\n")).toContain("オッズ種別: なし");
    expect(lines.join("\n")).toContain("未発売");
    expect(lines.join("\n")).toContain("◎1");
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
