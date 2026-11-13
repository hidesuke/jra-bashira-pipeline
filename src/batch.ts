import type { BashiraPort } from "./bashira/port";
import { ambiguousNameMessage } from "./bashira/mcp";
import { ExternalBudget } from "./budget";
import { enqueueRace, type EnqueueDeps } from "./enqueue";
import { loadJob, type JobState } from "./job";
import { nextJstDate } from "./jst";
import { keys, kvPutJson } from "./kv";
import { notifyBatchFailed, type NotifyConfig } from "./notify";
import { blocksNewRun } from "./pipeline";
import { parseRaceRequest } from "./race-ref";
import { meetingDay, numberField, rowsToObjects, stringField } from "./rows";
import { assertFields, assertToolArgs, catalogFromTools, type ToolCatalog } from "./schema";
import { errorMessage, JobError, VENUE_BY_CODE, type KvStore, type RaceRef } from "./types";

/** get_races の既定件数。KV が無い、または正の整数でないときはこれ。BASHIRA の limit 最大でもある。 */
export const DEFAULT_MEETING_RACE_LIMIT = 200;
/** get_races の offset 上限（スキーマの maximum）。これより深い続きは取れない。 */
export const MEETING_RACE_OFFSET_MAX = 2000;
/** data_version がページの途中で変わったとき、先頭から取り直す回数。 */
const PAGE_VERSION_RESTARTS = 1;

/** 要約は 1 開催日 1 キー。14 日で消す。 */
const BATCH_SUMMARY_TTL_SECONDS = 14 * 24 * 60 * 60;

const LIST_COLUMNS = ["race_id", "race_status", "race_meeting_date", "race_track", "race_number"] as const;

export interface BatchDeps extends EnqueueDeps {
  bashira: BashiraPort;
  log?(event: string, fields?: Record<string, unknown>): void;
  /** 上限エラーの通知。URL が無ければ送らない。 */
  notify?: NotifyConfig;
  fetch?: typeof fetch;
}

export interface BatchRaceResult {
  race_key: string | null;
  race_id: string | null;
  venue: string | null;
  race_number: number | null;
  action: "enqueued" | "would_enqueue" | "skipped" | "failed";
  reason: string | null;
  run_id: string | null;
}

export interface BatchSummary {
  date: string;
  source: "cron" | "admin";
  dry_run: boolean;
  scheduled_time: string | null;
  listed_by: "day" | "venue";
  enqueued: number;
  would_enqueue: number;
  skipped: number;
  failed: number;
  races: BatchRaceResult[];
  /** 列挙に使った get_races の limit。失敗のときも、送った値。 */
  limit_sent: number | null;
  /** BASHIRA が返した limit の上限。上限エラーのときだけ。 */
  limit_maximum: number | null;
  /** 上限エラーで列挙できなかった理由。成功のときは null。 */
  error: string | null;
}

/** BASHIRA が limit の maximum で get_races を拒んだ。要約を残したあと投げる。 */
export class BashiraLimitError extends JobError {
  summary: BatchSummary | null = null;
  constructor(
    message: string,
    readonly limitSent: number,
    readonly limitMaximum: number,
  ) {
    super(message, false);
    this.name = "BashiraLimitError";
  }
}

export function assertMeetingDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new JobError("date は YYYY-MM-DD です", false);
  }
  const [year, month, day] = date.split("-").map(Number);
  const check = new Date(Date.UTC(year!, month! - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) {
    throw new JobError(`日付「${date}」は暦にありません`, false);
  }
}

export async function handleScheduled(
  controller: { scheduledTime: number; cron?: string },
  deps: BatchDeps,
): Promise<BatchSummary> {
  let date: string;
  try {
    if (!Number.isFinite(controller.scheduledTime)) {
      throw new JobError("scheduledTime が時刻ではありません", false);
    }
    date = nextJstDate(new Date(controller.scheduledTime));
  } catch (err) {
    log(deps, "batch_failed", { source: "cron", error: errorMessage(err) });
    throw err;
  }
  try {
    return await runDateBatch(deps, {
      date,
      source: "cron",
      dryRun: false,
      requestedBy: "cron",
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
      cron: controller.cron ?? null,
    });
  } catch (err) {
    log(deps, "batch_failed", {
      source: "cron",
      date,
      error: errorMessage(err),
      limit_sent: err instanceof BashiraLimitError ? err.limitSent : null,
      limit_maximum: err instanceof BashiraLimitError ? err.limitMaximum : null,
    });
    throw err;
  }
}

export async function runDateBatch(
  deps: BatchDeps,
  input: {
    date: string;
    source: "cron" | "admin";
    dryRun: boolean;
    requestedBy: string;
    scheduledTime?: string | null;
    cron?: string | null;
  },
): Promise<BatchSummary> {
  assertMeetingDate(input.date);
  let listed: { rows: Record<string, unknown>[]; listedBy: "day" | "venue"; rowCount: number; limit: number };
  try {
    listed = await listMeetingRaces(deps, input.date);
  } catch (err) {
    if (err instanceof BashiraLimitError) {
      await recordLimitFailure(deps, input, err);
      throw err;
    }
    throw err;
  }
  const races: BatchRaceResult[] = [];
  const seen = new Set<string>();
  for (const row of listed.rows) {
    const outcome = await classifyRow(deps, row, input, seen);
    races.push(outcome);
  }
  races.sort(compareRace);
  const summary: BatchSummary = {
    date: input.date,
    source: input.source,
    dry_run: input.dryRun,
    scheduled_time: input.scheduledTime ?? null,
    listed_by: listed.listedBy,
    enqueued: races.filter((race) => race.action === "enqueued").length,
    would_enqueue: races.filter((race) => race.action === "would_enqueue").length,
    skipped: races.filter((race) => race.action === "skipped").length,
    failed: races.filter((race) => race.action === "failed").length,
    races,
    limit_sent: listed.limit,
    limit_maximum: null,
    error: null,
  };
  if (listed.rowCount === 0) {
    log(deps, "batch_empty", { date: input.date, source: input.source, dry_run: input.dryRun });
  }
  log(deps, "batch_finished", {
    date: summary.date,
    source: summary.source,
    dry_run: summary.dry_run,
    cron: input.cron ?? null,
    listed_by: summary.listed_by,
    enqueued: summary.enqueued,
    would_enqueue: summary.would_enqueue,
    skipped: summary.skipped,
    failed: summary.failed,
  });
  if (!input.dryRun) await writeSummary(deps, summary);
  return summary;
}

async function classifyRow(
  deps: BatchDeps,
  row: Record<string, unknown>,
  input: { date: string; dryRun: boolean; requestedBy: string },
  seen: Set<string>,
): Promise<BatchRaceResult> {
  const status = stringField(row, "race_status");
  const preview = previewOf(row);
  if (status === "canceled") return { ...preview, action: "skipped", reason: "中止", run_id: null };
  if (!status) return { ...preview, action: "failed", reason: "race_status がありません", run_id: null };
  let race: RaceRef;
  try {
    race = raceFromRow(row, input.date);
  } catch (err) {
    return { ...preview, action: "failed", reason: errorMessage(err), run_id: null };
  }
  const described = describe(race);
  if (seen.has(race.raceKey)) return { ...described, action: "skipped", reason: "重複", run_id: null };
  seen.add(race.raceKey);
  const job = await loadJob(deps.kv, race.raceKey);
  const skip = skipReason(job, deps.now().getTime());
  if (skip) return { ...described, action: "skipped", reason: skip, run_id: null };
  if (input.dryRun) return { ...described, action: "would_enqueue", reason: null, run_id: null };
  try {
    const queued = await enqueueRace(deps, { race, requestedBy: input.requestedBy });
    if (!queued.enqueued) return { ...described, action: "skipped", reason: "処理中", run_id: null };
    return { ...described, action: "enqueued", reason: null, run_id: queued.runId };
  } catch (err) {
    return { ...described, action: "failed", reason: errorMessage(err), run_id: null };
  }
}

function skipReason(job: JobState | null, nowMs: number): "完了済み" | "処理中" | null {
  if (!job) return null;
  if (job.phase === "done") return "完了済み";
  if (blocksNewRun(job, nowMs)) return "処理中";
  return null;
}

async function listMeetingRaces(
  deps: BatchDeps,
  date: string,
): Promise<{ rows: Record<string, unknown>[]; listedBy: "day" | "venue"; rowCount: number; limit: number }> {
  const listed = await deps.bashira.listTools();
  if (!listed.ok) throw new JobError(listed.message, listed.retryable);
  const catalog = catalogFromTools(listed.tools);
  const limit = await readMeetingRaceLimit(deps.kv);
  const dayFilters = { race_meeting_date: { gte: date, lte: date } };
  const canOffset = catalog.tools.get_races?.argNames.includes("offset") === true;
  if (canOffset) {
    const rows = await pageMeetingRaces(deps.bashira, catalog, dayFilters, limit, date);
    return { rows, listedBy: "day", rowCount: rows.length, limit };
  }
  const day = await callRaces(deps.bashira, catalog, dayFilters, limit, 0);
  if (!isTruncated(day.payload)) {
    return { rows: day.rows, listedBy: "day", rowCount: day.rows.length, limit };
  }
  const rows: Record<string, unknown>[] = [];
  for (const venue of Object.values(VENUE_BY_CODE)) {
    const page = await callRaces(deps.bashira, catalog, { ...dayFilters, race_track: venue }, limit, 0);
    if (isTruncated(page.payload)) {
      throw new JobError(
        `get_races が${venue}で打ち切られ、続きを取る offset が無いため、${date} の全レースを列挙できません`,
        false,
      );
    }
    rows.push(...page.rows);
  }
  return { rows, listedBy: "venue", rowCount: rows.length, limit };
}

/** offset で同じ条件の続きを取る。data_version が変わったら先頭から 1 回だけ取り直す。 */
async function pageMeetingRaces(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  filters: Record<string, unknown>,
  limit: number,
  date: string,
): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = [];
  let offset = 0;
  let version: string | null = null;
  let restarts = 0;
  for (;;) {
    const page = await callRaces(bashira, catalog, filters, limit, offset);
    const nextVersion = dataVersionOf(page.payload);
    if (offset > 0 && version !== nextVersion) {
      if (restarts >= PAGE_VERSION_RESTARTS) {
        throw new JobError(
          `get_races の data_version がページの途中で変わったため、${date} の全レースを列挙できません`,
          false,
        );
      }
      restarts += 1;
      rows = [];
      offset = 0;
      version = null;
      continue;
    }
    version = nextVersion;
    rows.push(...page.rows);
    if (!isTruncated(page.payload)) return rows;
    const count = pageRowCount(page.payload, page.rows.length);
    if (count <= 0) {
      throw new JobError(`get_races が truncated で行数が 0 のため、${date} の続きを取れません`, false);
    }
    if (offset + count > MEETING_RACE_OFFSET_MAX) {
      throw new JobError(
        `get_races の offset 上限 ${MEETING_RACE_OFFSET_MAX} を超えるため、${date} の全レースを列挙できません`,
        false,
      );
    }
    offset += count;
  }
}

async function callRaces(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  filters: Record<string, unknown>,
  limit: number,
  offset: number,
): Promise<{ payload: unknown; rows: Record<string, unknown>[] }> {
  const args: Record<string, unknown> = {
    filters,
    columns: [...LIST_COLUMNS],
    limit,
  };
  const shape = catalog.tools.get_races;
  if (shape?.argNames.includes("order_by")) args.order_by = "race_number";
  if (shape?.argNames.includes("order")) args.order = "asc";
  if (offset > 0 && shape?.argNames.includes("offset")) args.offset = offset;
  assertToolArgs(catalog, "get_races", args);
  assertFields(catalog, "get_races", [...LIST_COLUMNS, "filters", "columns", "limit"]);
  const result = await bashira.callTool("get_races", args);
  if (!result.ok) {
    const parsed = parseLimitMaximum(result.message);
    if (parsed) throw new BashiraLimitError(result.message, limit, parsed.maximum);
    throw new JobError(result.message, result.retryable);
  }
  const ambiguity = ambiguousNameMessage(result.data);
  if (ambiguity) throw new JobError(ambiguity, false);
  return { payload: result.data, rows: rowsToObjects(result.data) };
}

function isTruncated(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { truncated?: unknown }).truncated === true);
}

function raceFromRow(row: Record<string, unknown>, date: string): RaceRef {
  const track = stringField(row, "race_track");
  const raceNumber = numberField(row, "race_number");
  const raceId = stringField(row, "race_id");
  const meeting = meetingDay(stringField(row, "race_meeting_date"));
  let race: RaceRef;
  if (raceId && track && raceNumber != null && meeting) {
    race = parseRaceRequest({ race_id: raceId, date: meeting, venue: track, race_number: raceNumber });
  } else if (raceId) {
    race = parseRaceRequest({ race_id: raceId });
  } else {
    race = parseRaceRequest({ date, venue: track, race_number: raceNumber });
  }
  if (race.date !== date) throw new JobError(`開催日が ${date} ではありません`, false);
  return race;
}

function previewOf(row: Record<string, unknown>): Omit<BatchRaceResult, "action" | "reason" | "run_id"> {
  const raceId = stringField(row, "race_id");
  const venue = stringField(row, "race_track");
  const raceNumber = numberField(row, "race_number");
  return {
    race_key: raceId,
    race_id: raceId,
    venue,
    race_number: raceNumber,
  };
}

function describe(race: RaceRef): Omit<BatchRaceResult, "action" | "reason" | "run_id"> {
  return {
    race_key: race.raceKey,
    race_id: race.raceId,
    venue: race.venue,
    race_number: race.raceNumber,
  };
}

function compareRace(a: BatchRaceResult, b: BatchRaceResult): number {
  const key = (race: BatchRaceResult) => race.race_key ?? `${race.venue ?? ""}-${race.race_number ?? 99}`;
  return key(a).localeCompare(key(b), "ja");
}

async function writeSummary(deps: BatchDeps, summary: BatchSummary): Promise<void> {
  try {
    await kvPutJson(deps.kv, keys.batch(summary.date), summary, BATCH_SUMMARY_TTL_SECONDS);
  } catch (err) {
    log(deps, "batch_summary_failed", { date: summary.date, error: errorMessage(err) });
  }
}

function log(deps: BatchDeps, event: string, fields: Record<string, unknown>): void {
  if (deps.log) deps.log(event, fields);
  else console.log(JSON.stringify({ event, ...fields }));
}

/** KV の `config:get-races-limit`。無い、空、正の整数でないときは 200。 */
export function parseMeetingRaceLimit(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_MEETING_RACE_LIMIT;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_MEETING_RACE_LIMIT;
  try {
    return positiveIntLimit(JSON.parse(trimmed)) ?? DEFAULT_MEETING_RACE_LIMIT;
  } catch {
    return DEFAULT_MEETING_RACE_LIMIT;
  }
}

export async function readMeetingRaceLimit(kv: KvStore): Promise<number> {
  return parseMeetingRaceLimit(await kv.get(keys.getRacesLimit));
}

function positiveIntLimit(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return positiveIntLimit(Number(value));
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  return null;
}

/**
 * `validating /properties/limit: maximum: 500/1 is greater than 200.000000` の形。
 * 戻り値の maximum が BASHIRA の上限、sent はメッセージ上の送信値。
 */
export function parseLimitMaximum(message: string): { sent: number; maximum: number } | null {
  const match = /\/properties\/limit:\s*maximum:\s*([0-9]+(?:\.[0-9]+)?)\/1\s+is greater than\s+([0-9]+(?:\.[0-9]+)?)/.exec(message);
  if (!match) return null;
  const sent = Number(match[1]);
  const maximum = Number(match[2]);
  if (!Number.isFinite(sent) || !Number.isFinite(maximum)) return null;
  return { sent, maximum };
}

export function limitRejectedMessage(sent: number, maximum: number, raw: string): string {
  return `get_races の limit が BASHIRA の上限を超えています。送った limit は ${sent}、上限は ${maximum} です。KV の ${keys.getRacesLimit} を ${maximum} 以下にしてから、POST /admin/batch で積み直してください。元のエラー: ${raw}`;
}

async function recordLimitFailure(
  deps: BatchDeps,
  input: {
    date: string;
    source: "cron" | "admin";
    dryRun: boolean;
    scheduledTime?: string | null;
  },
  err: BashiraLimitError,
): Promise<void> {
  const summary: BatchSummary = {
    date: input.date,
    source: input.source,
    dry_run: input.dryRun,
    scheduled_time: input.scheduledTime ?? null,
    listed_by: "day",
    enqueued: 0,
    would_enqueue: 0,
    skipped: 0,
    failed: 0,
    races: [],
    limit_sent: err.limitSent,
    limit_maximum: err.limitMaximum,
    error: limitRejectedMessage(err.limitSent, err.limitMaximum, err.message),
  };
  err.summary = summary;
  await writeSummary(deps, summary);
  log(deps, "batch_limit_rejected", {
    date: summary.date,
    source: summary.source,
    dry_run: summary.dry_run,
    limit_sent: summary.limit_sent,
    limit_maximum: summary.limit_maximum,
  });
  await notifyBatchFailed(deps.notify, {
    date: summary.date,
    source: summary.source,
    error: summary.error ?? err.message,
    limitSent: err.limitSent,
    limitMaximum: err.limitMaximum,
    occurredAt: deps.now(),
  }, {
    budget: new ExternalBudget(),
    fetch: deps.fetch,
    log: deps.log,
  });
}

function dataVersionOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { data_version?: unknown }).data_version;
  return typeof value === "string" && value !== "" ? value : null;
}

function pageRowCount(payload: unknown, rowLength: number): number {
  if (!payload || typeof payload !== "object") return rowLength;
  const reported = numberField(payload as Record<string, unknown>, "row_count");
  if (reported != null && reported >= 0) return reported;
  return rowLength;
}
