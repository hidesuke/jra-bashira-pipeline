import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BashiraPort } from "../src/bashira/port";
import {
  BashiraLimitError,
  DEFAULT_MEETING_RACE_LIMIT,
  handleScheduled,
  parseLimitMaximum,
  parseMeetingRaceLimit,
  runDateBatch,
  type BatchDeps,
  type BatchSummary,
} from "../src/batch";
import { NEXT_DAY_BATCH_CRON } from "../src/cron";
import { handleRequest, type HttpDeps } from "../src/http";
import { jstCalendarDate, jstWeekday, nextJstDate } from "../src/jst";
import { keys, MemoryKv } from "../src/kv";
import { notionRaceFilter, pageMatchesRace } from "../src/notion";
import { handleJobMessage, type PipelineDeps } from "../src/pipeline";
import { QUEUE_MAX_CONCURRENCY, QUEUE_MAX_RETRIES, type JobMessage, type RaceRef } from "../src/types";
import { bashiraTools } from "./fixture";
import type { McpTool } from "../src/schema";

const LIMIT_ERROR =
  'validating "arguments": validating root: validating /properties/limit: maximum: 500/1 is greater than 200.000000';

function toolsWithOffset(): McpTool[] {
  return bashiraTools.map((entry) => {
    if (entry.name !== "get_races") return entry;
    const schema = entry.inputSchema as { properties: Record<string, unknown> };
    return {
      ...entry,
      inputSchema: {
        ...schema,
        properties: {
          ...schema.properties,
          offset: { type: "integer" },
          order_by: { type: "string" },
          order: { type: "string" },
        },
      },
    };
  });
}

const DATE = "2026-11-09";

function raceRow(raceNumber: number, status = "upcoming", venue = "東京", code = "05", date = DATE) {
  const race = String(raceNumber).padStart(2, "0");
  const id = `${date.replaceAll("-", "")}-${code}-${race}`;
  return {
    race_id: id,
    race_status: status,
    race_meeting_date: `${date}T00:00:00Z`,
    race_track: venue,
    race_number: raceNumber,
  };
}

function port(
  rowsFor: (
    filters: Record<string, unknown>,
    args: Record<string, unknown>,
  ) => { truncated?: boolean; rows: Array<Record<string, unknown>>; row_count?: number; data_version?: string },
  tools: McpTool[] = bashiraTools,
): {
  bashira: BashiraPort;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const bashira: BashiraPort = {
    async listTools() {
      return { ok: true, tools };
    },
    async callTool(_name, args) {
      calls.push(args);
      const filters = (args.filters ?? {}) as Record<string, unknown>;
      return { ok: true, data: rowsFor(filters, args) };
    },
    async callTools() {
      return { ok: false, code: "upstream", retryable: true, message: "no", results: [] };
    },
  };
  return { bashira, calls };
}

function harness(bashira: BashiraPort, enqueue?: (message: JobMessage) => Promise<void>) {
  const kv = new MemoryKv();
  const messages: JobMessage[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const deps: BatchDeps = {
    kv,
    bashira,
    now: () => new Date("2026-11-08T07:45:00Z"),
    enqueue: enqueue ?? (async (message) => {
      messages.push(message);
    }),
    log(event, fields) {
      logs.push({ event, ...fields });
    },
  };
  return { kv, messages, logs, deps };
}

function pipeline(kv: MemoryKv): PipelineDeps {
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
    bashira: {
      async listTools() {
        throw new Error("BASHIRA を呼ばない");
      },
      async callTool() {
        throw new Error("BASHIRA を呼ばない");
      },
      async callTools() {
        throw new Error("BASHIRA を呼ばない");
      },
    },
    enqueue: async () => {},
    now: () => new Date("2026-11-08T07:45:00Z"),
  };
}

const tokyo = (raceNumber: number): RaceRef => ({
  raceKey: `20261109-05-${String(raceNumber).padStart(2, "0")}`,
  raceId: `20261109-05-${String(raceNumber).padStart(2, "0")}`,
  date: DATE,
  venue: "東京",
  venueCode: "05",
  raceNumber,
});

describe("next JST date", () => {
  it("moves Friday and Saturday 16:45 JST to the next calendar day", () => {
    const friday = new Date("2026-11-06T07:45:00Z");
    const saturday = new Date("2026-11-07T07:45:00Z");
    expect(jstWeekday(friday)).toBe("Fri");
    expect(jstWeekday(saturday)).toBe("Sat");
    expect(jstCalendarDate(friday)).toBe("2026-11-06");
    expect(nextJstDate(friday)).toBe("2026-11-07");
    expect(nextJstDate(saturday)).toBe("2026-11-08");
  });

  it("uses the JST date across UTC midnight", () => {
    const justBeforeJstSaturday = new Date("2026-11-06T14:59:00Z");
    const jstSaturdayMidnight = new Date("2026-11-06T15:00:00Z");
    expect(jstCalendarDate(justBeforeJstSaturday)).toBe("2026-11-06");
    expect(jstWeekday(justBeforeJstSaturday)).toBe("Fri");
    expect(nextJstDate(justBeforeJstSaturday)).toBe("2026-11-07");
    expect(jstCalendarDate(jstSaturdayMidnight)).toBe("2026-11-07");
    expect(jstWeekday(jstSaturdayMidnight)).toBe("Sat");
    expect(nextJstDate(jstSaturdayMidnight)).toBe("2026-11-08");
    expect(jstCalendarDate(new Date("2026-11-07T00:00:00Z"))).toBe("2026-11-07");
    expect(nextJstDate(new Date("2026-11-07T00:00:00Z"))).toBe("2026-11-08");
  });
});

describe("meeting batch", () => {
  it("enqueues every race except a canceled one, and records one summary", async () => {
    const { bashira, calls } = port(() => ({
      truncated: false,
      rows: [raceRow(1), raceRow(2, "canceled"), raceRow(12)],
    }));
    const env = harness(bashira);
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(summary.enqueued).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.listed_by).toBe("day");
    expect(env.messages.map((message) => (message.kind === "start" ? message.race.raceNumber : 0))).toEqual([1, 12]);
    expect(env.messages.every((message) => message.kind === "start" && message.requestedBy === "cron")).toBe(true);
    expect(calls[0]).toMatchObject({
      limit: DEFAULT_MEETING_RACE_LIMIT,
      filters: { race_meeting_date: { gte: DATE, lte: DATE } },
    });
    expect(calls.every((call) => Number(call.limit) <= 200)).toBe(true);
    expect(calls.every((call) => !("offset" in call))).toBe(true);
    expect(summary.limit_sent).toBe(200);
    expect(summary.limit_maximum).toBeNull();
    expect(summary.error).toBeNull();
    expect(calls).toHaveLength(1);
    const stored = JSON.parse((await env.kv.get(keys.batch(DATE))) ?? "{}") as BatchSummary;
    expect(stored.enqueued).toBe(2);
    expect(await env.kv.get(keys.lock("20261109-05-02"))).toBeNull();
    expect(await env.kv.get(keys.lock("20261109-05-01"))).toContain("cron");
  });

  it("logs and returns when the day has no races", async () => {
    const { bashira } = port(() => ({ truncated: false, rows: [] }));
    const env = harness(bashira);
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(summary.enqueued).toBe(0);
    expect(summary.races).toEqual([]);
    expect(env.messages).toHaveLength(0);
    expect(env.logs.some((entry) => entry.event === "batch_empty")).toBe(true);
    expect(await env.kv.get(keys.batch(DATE))).toContain('"enqueued":0');
  });

  it("re-queries each venue when the day list is truncated and offset is absent", async () => {
    const { bashira, calls } = port((filters) => {
      if (!filters.race_track) {
        return { truncated: true, rows: [raceRow(1, "upcoming", "函館", "02")] };
      }
      if (filters.race_track === "東京") return { truncated: false, rows: [raceRow(1), raceRow(2)] };
      if (filters.race_track === "京都") return { truncated: false, rows: [raceRow(3, "upcoming", "京都", "08")] };
      return { truncated: false, rows: [] };
    });
    const env = harness(bashira);
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(summary.listed_by).toBe("venue");
    expect(summary.enqueued).toBe(3);
    expect(env.messages.map((message) => (message.kind === "start" ? message.race.raceKey : ""))).toEqual([
      "20261109-05-01",
      "20261109-05-02",
      "20261109-08-03",
    ]);
    expect(calls.some((call) => call.filters && (call.filters as { race_track?: string }).race_track === "函館")).toBe(true);
    expect(env.messages.some((message) => message.kind === "start" && message.race.venue === "函館")).toBe(false);
  });

  it("does not enqueue a partial card when a venue list is still truncated and offset is absent", async () => {
    const { bashira } = port((filters) => {
      if (!filters.race_track) return { truncated: true, rows: [raceRow(1)] };
      if (filters.race_track === "東京") return { truncated: true, rows: [raceRow(1)] };
      return { truncated: false, rows: [] };
    });
    const env = harness(bashira);
    await expect(
      runDateBatch(env.deps, { date: DATE, source: "cron", dryRun: false, requestedBy: "cron" }),
    ).rejects.toThrow(/offset/);
    expect(env.messages).toHaveLength(0);
    expect(await env.kv.get(keys.batch(DATE))).toBeNull();
  });

  it("pages with offset until every race on the day is listed", async () => {
    const all = [
      ...Array.from({ length: 12 }, (_, index) => raceRow(index + 1, "upcoming", "東京", "05")),
      ...Array.from({ length: 12 }, (_, index) => raceRow(index + 1, "upcoming", "京都", "08")),
      ...Array.from({ length: 12 }, (_, index) => raceRow(index + 1, "upcoming", "阪神", "09")),
    ];
    const pageSize = 20;
    const { bashira, calls } = port((filters, args) => {
      expect(filters.race_track).toBeUndefined();
      const offset = Number(args.offset ?? 0);
      const rows = all.slice(offset, offset + pageSize);
      return {
        truncated: offset + rows.length < all.length,
        rows,
        row_count: rows.length,
        data_version: "v1",
      };
    }, toolsWithOffset());
    const env = harness(bashira);
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(summary.enqueued).toBe(all.length);
    expect(summary.listed_by).toBe("day");
    expect(summary.failed).toBe(0);
    expect(calls.map((call) => call.limit)).toEqual([200, 200]);
    expect(calls.every((call) => Number(call.limit) <= 200)).toBe(true);
    expect(calls[1]?.offset).toBe(pageSize);
    expect(calls[0]?.order_by).toBe("race_number");
    expect(env.messages).toHaveLength(all.length);
  });

  it("restarts from the first page when data_version changes", async () => {
    let fresh = false;
    const { bashira } = port((_filters, args) => {
      const offset = Number(args.offset ?? 0);
      if (!fresh) {
        if (offset === 0) return { truncated: true, rows: [raceRow(1)], row_count: 1, data_version: "v1" };
        fresh = true;
        return { truncated: true, rows: [raceRow(9)], row_count: 1, data_version: "v2" };
      }
      if (offset === 0) return { truncated: true, rows: [raceRow(2)], row_count: 1, data_version: "v2" };
      return { truncated: false, rows: [raceRow(3)], row_count: 1, data_version: "v2" };
    }, toolsWithOffset());
    const env = harness(bashira);
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(summary.races.map((race) => race.race_number)).toEqual([2, 3]);
    expect(summary.enqueued).toBe(2);
  });

  it("does not enqueue a partial card when offset cannot pass its maximum", async () => {
    const { bashira } = port((_filters, args) => {
      const offset = Number(args.offset ?? 0);
      if (offset === 0) return { truncated: true, rows: [raceRow(1)], row_count: 2000, data_version: "v" };
      return { truncated: true, rows: [raceRow(2)], row_count: 1, data_version: "v" };
    }, toolsWithOffset());
    const env = harness(bashira);
    await expect(
      runDateBatch(env.deps, { date: DATE, source: "cron", dryRun: false, requestedBy: "cron" }),
    ).rejects.toThrow(/offset 上限/);
    expect(env.messages).toHaveLength(0);
    expect(await env.kv.get(keys.batch(DATE))).toBeNull();
  });

  it("reads the get_races limit from KV and falls back to 200", async () => {
    expect(parseMeetingRaceLimit(null)).toBe(200);
    expect(parseMeetingRaceLimit("")).toBe(200);
    expect(parseMeetingRaceLimit("nope")).toBe(200);
    expect(parseMeetingRaceLimit("0")).toBe(200);
    expect(parseMeetingRaceLimit("-3")).toBe(200);
    expect(parseMeetingRaceLimit("1.5")).toBe(200);
    expect(parseMeetingRaceLimit('"80"')).toBe(80);
    expect(parseMeetingRaceLimit("50")).toBe(50);
    expect(parseLimitMaximum(LIMIT_ERROR)).toEqual({ sent: 500, maximum: 200 });
    expect(parseLimitMaximum("別の失敗")).toBeNull();

    const sent: number[] = [];
    const { bashira } = port((_filters, args) => {
      sent.push(Number(args.limit));
      return { truncated: false, rows: [raceRow(1)] };
    });
    const missing = harness(bashira);
    await runDateBatch(missing.deps, { date: DATE, source: "admin", dryRun: true, requestedBy: "Muse" });
    await missing.kv.put(keys.getRacesLimit, "nope");
    await runDateBatch(missing.deps, { date: DATE, source: "admin", dryRun: true, requestedBy: "Muse" });
    await missing.kv.put(keys.getRacesLimit, "50");
    const summary = await runDateBatch(missing.deps, { date: DATE, source: "admin", dryRun: true, requestedBy: "Muse" });
    expect(sent).toEqual([200, 200, 50]);
    expect(summary.limit_sent).toBe(50);
    expect(sent.every((limit) => limit <= 200)).toBe(true);
  });

  it("records the BASHIRA limit maximum and does not enqueue when limit is rejected", async () => {
    const { bashira, calls } = port(() => ({ truncated: false, rows: [] }));
    const failing: BashiraPort = {
      listTools: () => bashira.listTools(),
      async callTool(_name, args) {
        calls.push(args);
        return { ok: false, code: "upstream", retryable: true, message: LIMIT_ERROR };
      },
      callTools: () => bashira.callTools([]),
    };
    const env = harness(failing);
    await env.kv.put(keys.getRacesLimit, "500");
    const bodies: Array<Record<string, unknown>> = [];
    env.deps.notify = { url: "https://notify.test/hook", key: "super-secret" };
    env.deps.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    };
    await expect(
      runDateBatch(env.deps, { date: DATE, source: "cron", dryRun: true, requestedBy: "cron" }),
    ).rejects.toBeInstanceOf(BashiraLimitError);
    expect(env.messages).toHaveLength(0);
    expect(calls[0]?.limit).toBe(500);
    const stored = JSON.parse((await env.kv.get(keys.batch(DATE))) ?? "{}") as BatchSummary;
    expect(stored.limit_sent).toBe(500);
    expect(stored.limit_maximum).toBe(200);
    expect(stored.error).toContain("送った limit は 500");
    expect(stored.error).toContain("上限は 200");
    expect(stored.error).toContain(LIMIT_ERROR);
    expect(stored.enqueued).toBe(0);
    expect(stored.races).toEqual([]);
    expect(bodies[0]).toMatchObject({
      type: "batch_failed",
      date: DATE,
      source: "cron",
      limit_sent: 500,
      limit_maximum: 200,
    });
    expect(String(bodies[0]?.error)).toContain("200");
    expect(String(bodies[0]?.error)).toContain("500");
    expect(JSON.stringify(env.logs)).not.toContain("super-secret");
    expect(JSON.stringify(bodies)).not.toContain("super-secret");
  });

  it("skips an active or done job and enqueues a failed one again", async () => {
    const { bashira } = port(() => ({ truncated: false, rows: [raceRow(1), raceRow(2), raceRow(3)] }));
    const env = harness(bashira);
    const now = env.deps.now().toISOString();
    await env.kv.put(keys.job("20261109-05-01"), JSON.stringify({ phase: "done", updatedAt: now, runId: "old" }));
    await env.kv.put(keys.job("20261109-05-02"), JSON.stringify({ phase: "predict", updatedAt: now, runId: "live" }));
    await env.kv.put(keys.job("20261109-05-03"), JSON.stringify({ phase: "error", error: "失敗", updatedAt: now, runId: "bad" }));
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "admin",
      dryRun: false,
      requestedBy: "Grok Bot",
    });
    expect(summary.races.map((race) => [race.race_number, race.action, race.reason])).toEqual([
      [1, "skipped", "完了済み"],
      [2, "skipped", "処理中"],
      [3, "enqueued", null],
    ]);
    expect(env.messages).toHaveLength(1);
    const again = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(again.enqueued).toBe(0);
    expect(again.skipped).toBe(3);
    expect(env.messages).toHaveLength(1);
  });

  it("keeps going when one enqueue fails", async () => {
    const { bashira } = port(() => ({ truncated: false, rows: [raceRow(1), raceRow(2), raceRow(3)] }));
    const env = harness(bashira, async (message) => {
      if (message.kind === "start" && message.race.raceNumber === 2) throw new Error("queue unavailable");
      env.messages.push(message);
    });
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(summary.enqueued).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.races.find((race) => race.race_number === 2)?.reason).toContain("queue unavailable");
    expect(env.messages).toHaveLength(2);
    expect(await env.kv.get(keys.lock("20261109-05-02"))).toBeNull();
  });

  it("lists races on a dry run without writing the queue, locks, or the summary", async () => {
    const { bashira } = port(() => ({ truncated: false, rows: [raceRow(1), raceRow(2, "canceled")] }));
    const env = harness(bashira);
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "admin",
      dryRun: true,
      requestedBy: "Muse",
    });
    expect(summary.dry_run).toBe(true);
    expect(summary.would_enqueue).toBe(1);
    expect(summary.enqueued).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(env.messages).toHaveLength(0);
    expect(await env.kv.get(keys.lock("20261109-05-01"))).toBeNull();
    expect(await env.kv.get(keys.batch(DATE))).toBeNull();
  });

  it("targets the next JST day from the cron timestamp", async () => {
    const seen: string[] = [];
    const { bashira } = port((filters) => {
      const range = filters.race_meeting_date as { gte?: string };
      seen.push(range.gte ?? "");
      return { truncated: false, rows: [] };
    });
    const env = harness(bashira);
    const summary = await handleScheduled(
      { scheduledTime: Date.parse("2026-11-07T07:45:00Z"), cron: NEXT_DAY_BATCH_CRON },
      env.deps,
    );
    expect(summary.date).toBe("2026-11-08");
    expect(seen).toEqual(["2026-11-08"]);
    expect(env.logs.some((entry) => entry.event === "batch_empty")).toBe(true);
  });

  it("records the limit rejection for the next JST day and still fails the cron", async () => {
    const { bashira, calls } = port(() => ({ truncated: false, rows: [] }));
    const failing: BashiraPort = {
      listTools: () => bashira.listTools(),
      async callTool(_name, args) {
        calls.push(args);
        return { ok: false, code: "upstream", retryable: true, message: LIMIT_ERROR };
      },
      callTools: () => bashira.callTools([]),
    };
    const env = harness(failing);
    await env.kv.put(keys.getRacesLimit, "500");
    await expect(
      handleScheduled({ scheduledTime: Date.parse("2026-11-13T07:45:00Z"), cron: NEXT_DAY_BATCH_CRON }, env.deps),
    ).rejects.toBeInstanceOf(BashiraLimitError);
    const stored = JSON.parse((await env.kv.get(keys.batch("2026-11-14"))) ?? "{}") as BatchSummary;
    expect(stored.date).toBe("2026-11-14");
    expect(stored.source).toBe("cron");
    expect(stored.limit_sent).toBe(500);
    expect(stored.limit_maximum).toBe(200);
    expect(stored.enqueued).toBe(0);
    expect(env.logs.some((entry) => entry.event === "batch_limit_rejected" && entry.limit_maximum === 200)).toBe(true);
    expect(env.messages).toHaveLength(0);
  });
});

describe("admin batch route", () => {
  it("requires Access and can dry-run a date", async () => {
    const { bashira } = port(() => ({ truncated: false, rows: [raceRow(1)] }));
    const kv = new MemoryKv();
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
        accessAud: "aud-tag",
        accessClientIdGrok: "grok-id",
        accessClientIdMuse: "muse-id",
      },
      kv,
      bashira,
      now: () => new Date("2026-11-08T07:45:00Z"),
      enqueue: async () => {
        throw new Error("dry-run では積まない");
      },
      log: () => {},
      verifyJwt: async () => ({ common_name: "ignored" }),
      oauth: {
        async getStatus() {
          return { registered: true, authorized: true, needsReauth: false, expiresAt: null, lastError: null };
        },
        async beginAuthorization() {
          return { url: "https://example.test" };
        },
        async completeAuthorization() {
          return { ok: true };
        },
      },
    };
    const denied = await handleRequest(
      new Request("https://worker.example/admin/batch", { method: "POST", body: JSON.stringify({ date: DATE }) }),
      http,
    );
    expect(denied.status).toBe(403);
    const headers = new Headers({ "cf-access-jwt-assertion": "token", "cf-access-client-id": "grok-id" });
    const bad = await handleRequest(
      new Request("https://worker.example/admin/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ date: "20261109", dry_run: true }),
      }),
      http,
    );
    expect(bad.status).toBe(400);
    const ok = await handleRequest(
      new Request("https://worker.example/admin/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ date: DATE, dry_run: true }),
      }),
      http,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as BatchSummary;
    expect(body.would_enqueue).toBe(1);
    expect(body.races[0]?.race_key).toBe("20261109-05-01");
    expect(body.races[0]?.action).toBe("would_enqueue");
    expect(body.limit_sent).toBe(200);
  });

  it("returns the limit maximum on 400 and keeps the summary", async () => {
    const { bashira, calls } = port(() => ({ truncated: false, rows: [] }));
    const failing: BashiraPort = {
      listTools: () => bashira.listTools(),
      async callTool(_name, args) {
        calls.push(args);
        return { ok: false, code: "upstream", retryable: true, message: LIMIT_ERROR };
      },
      callTools: () => bashira.callTools([]),
    };
    const kv = new MemoryKv();
    await kv.put(keys.getRacesLimit, "500");
    const bodies: Array<Record<string, unknown>> = [];
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
        accessAud: "aud-tag",
        accessClientIdGrok: "grok-id",
        accessClientIdMuse: "muse-id",
      },
      kv,
      bashira: failing,
      now: () => new Date("2026-11-13T07:45:00Z"),
      enqueue: async () => {
        throw new Error("上限エラーでは積まない");
      },
      log: () => {},
      notify: { url: "https://notify.test/hook" },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      },
      verifyJwt: async () => ({ common_name: "ignored" }),
      oauth: {
        async getStatus() {
          return { registered: true, authorized: true, needsReauth: false, expiresAt: null, lastError: null };
        },
        async beginAuthorization() {
          return { url: "https://example.test" };
        },
        async completeAuthorization() {
          return { ok: true };
        },
      },
    };
    const headers = new Headers({ "cf-access-jwt-assertion": "token", "cf-access-client-id": "grok-id" });
    const response = await handleRequest(
      new Request("https://worker.example/admin/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ date: "2026-11-14", dry_run: true }),
      }),
      http,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchSummary;
    expect(body.limit_sent).toBe(500);
    expect(body.limit_maximum).toBe(200);
    expect(body.error).toContain("上限は 200");
    expect(body.enqueued).toBe(0);
    const stored = JSON.parse((await kv.get(keys.batch("2026-11-14"))) ?? "{}") as BatchSummary;
    expect(stored.limit_maximum).toBe(200);
    expect(bodies[0]).toMatchObject({ type: "batch_failed", limit_sent: 500, limit_maximum: 200, source: "admin" });
  });
});

describe("concurrency", () => {
  it("keeps Notion searches and page keys on the race that owns them", () => {
    const other: RaceRef = {
      raceKey: "20261109-08-02",
      raceId: "20261109-08-02",
      date: DATE,
      venue: "京都",
      venueCode: "08",
      raceNumber: 2,
    };
    expect(notionRaceFilter(tokyo(1))).not.toEqual(notionRaceFilter(other));
    expect(notionRaceFilter(tokyo(1)).and[1]).toEqual({ property: "競馬場", select: { equals: "東京" } });
    expect(notionRaceFilter(other).and[2]).toEqual({ property: "レース", select: { equals: "2" } });
    const page = {
      properties: {
        日付: { date: { start: DATE } },
        競馬場: { select: { name: "東京" } },
        レース: { select: { name: "1" } },
      },
    };
    expect(pageMatchesRace(page, tokyo(1))).toBe(true);
    expect(pageMatchesRace(page, other)).toBe(false);
    expect(keys.notionPage(tokyo(1).raceKey)).not.toBe(keys.notionPage(other.raceKey));
    expect(keys.job(tokyo(1).raceKey)).not.toBe(keys.job(other.raceKey));
  });

  it("retries a later phase until that race's job is visible, and does not run it early", async () => {
    const kv = new MemoryKv();
    const deps = pipeline(kv);
    const raceKey = tokyo(1).raceKey;
    expect(await handleJobMessage({ kind: "form", runId: "run-1", raceKey }, deps)).toBe("retry");
    expect(await kv.get(keys.job(raceKey))).toBeNull();

    await kv.put(
      keys.job(raceKey),
      JSON.stringify({ runId: "run-1", phase: "form", updatedAt: "2026-11-08T07:45:00.000Z", race: tokyo(1) }),
    );
    expect(await handleJobMessage({ kind: "stats", runId: "run-1", raceKey }, deps)).toBe("retry");
    const waiting = JSON.parse((await kv.get(keys.job(raceKey))) ?? "{}") as { phase?: string; retry?: unknown };
    expect(waiting.phase).toBe("form");
    expect(waiting.retry).toBeUndefined();

    await kv.put(
      keys.job(raceKey),
      JSON.stringify({ runId: "run-1", phase: "predict", updatedAt: "2026-11-08T07:45:00.000Z", race: tokyo(1) }),
    );
    expect(await handleJobMessage({ kind: "form", runId: "run-1", raceKey }, deps)).toBe("ack");
    const ahead = JSON.parse((await kv.get(keys.job(raceKey))) ?? "{}") as { phase?: string };
    expect(ahead.phase).toBe("predict");
  });

  it("enqueues two races side by side and does not let the second start replace the first", async () => {
    const { bashira } = port(() => ({ truncated: false, rows: [raceRow(1), raceRow(2)] }));
    const env = harness(bashira);
    const summary = await runDateBatch(env.deps, {
      date: DATE,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
    });
    expect(summary.enqueued).toBe(2);
    expect(new Set(env.messages.map((message) => (message.kind === "start" ? message.runId : ""))).size).toBe(2);
    const first = env.messages[0];
    if (first?.kind !== "start") throw new Error("start がありません");
    const decision = await handleJobMessage(
      { ...first, runId: "other-run" },
      {
        ...pipeline(env.kv),
        enqueue: env.deps.enqueue,
      },
    );
    expect(decision).toBe("ack");
    expect(env.messages).toHaveLength(2);
    const lock = await env.kv.get(keys.lock(first.race.raceKey));
    expect(lock).toContain(first.runId);
    expect(lock).not.toContain("other-run");
  });
});

describe("worker schedule config", () => {
  it("keeps cron triggers empty and runs one race at a time", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    expect(text).toContain('"triggers"');
    expect(text).toContain('"crons": []');
    expect(text).not.toContain(NEXT_DAY_BATCH_CRON);
    expect(text).toContain('"max_batch_size": 1');
    expect(text).toContain('"max_batch_timeout": 1');
    expect(text).toContain('"max_retries": 3');
    expect(text).toContain('"retry_delay": 30');
    expect(text).toContain('"dead_letter_queue": "jra-bashira-race-dlq"');
    expect(text).toContain('"max_concurrency": 1');
    expect(text).not.toContain('"max_concurrency": 3');
    expect(QUEUE_MAX_CONCURRENCY).toBe(1);
    expect(QUEUE_MAX_RETRIES).toBe(3);
    const queue = readFileSync(join(root, "src/index.ts"), "utf8");
    const handler = queue.slice(queue.indexOf("async queue"), queue.indexOf("async scheduled"));
    expect(handler).toContain("for (const message of batch.messages)");
    expect(handler).not.toContain("Promise.all");
    const previews = text.slice(text.indexOf('"previews"'));
    expect(previews).not.toContain('"crons"');
    expect(previews).not.toContain('"queues"');
  });
});
