import type { BashiraPort } from "./bashira/port";
import { ambiguousNameMessage } from "./bashira/mcp";
import { enqueueRace, type EnqueueDeps } from "./enqueue";
import { loadJob, type JobState } from "./job";
import { nextJstDate } from "./jst";
import { keys, kvPutJson } from "./kv";
import { blocksNewRun } from "./pipeline";
import { parseRaceRequest } from "./race-ref";
import { meetingDay, numberField, rowsToObjects, stringField } from "./rows";
import { assertFields, assertToolArgs, catalogFromTools, type ToolCatalog } from "./schema";
import { errorMessage, JobError, VENUE_BY_CODE, type RaceRef } from "./types";

/** get_races の上限。offset は無いので、打ち切れたら開催場ごとに取り直す。 */
export const MEETING_RACE_LIMIT = 500;

/** 要約は 1 開催日 1 キー。14 日で消す。 */
const BATCH_SUMMARY_TTL_SECONDS = 14 * 24 * 60 * 60;

const LIST_COLUMNS = ["race_id", "race_status", "race_meeting_date", "race_track", "race_number"] as const;

export interface BatchDeps extends EnqueueDeps {
  bashira: BashiraPort;
  log?(event: string, fields?: Record<string, unknown>): void;
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
    log(deps, "batch_failed", { source: "cron", date, error: errorMessage(err) });
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
  const listed = await listMeetingRaces(deps.bashira, input.date);
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
  bashira: BashiraPort,
  date: string,
): Promise<{ rows: Record<string, unknown>[]; listedBy: "day" | "venue"; rowCount: number }> {
  const listed = await bashira.listTools();
  if (!listed.ok) throw new JobError(listed.message, listed.retryable);
  const catalog = catalogFromTools(listed.tools);
  const day = await callRaces(bashira, catalog, { race_meeting_date: { gte: date, lte: date } });
  if (!isTruncated(day.payload)) {
    return { rows: day.rows, listedBy: "day", rowCount: day.rows.length };
  }
  const rows: Record<string, unknown>[] = [];
  for (const venue of Object.values(VENUE_BY_CODE)) {
    const page = await callRaces(bashira, catalog, {
      race_meeting_date: { gte: date, lte: date },
      race_track: venue,
    });
    if (isTruncated(page.payload)) {
      throw new JobError(
        `get_races が${venue}で打ち切られ、続きを取る offset が無いため、${date} の全レースを列挙できません`,
        false,
      );
    }
    rows.push(...page.rows);
  }
  return { rows, listedBy: "venue", rowCount: rows.length };
}

async function callRaces(
  bashira: BashiraPort,
  catalog: ToolCatalog,
  filters: Record<string, unknown>,
): Promise<{ payload: unknown; rows: Record<string, unknown>[] }> {
  const args: Record<string, unknown> = {
    filters,
    columns: [...LIST_COLUMNS],
    limit: MEETING_RACE_LIMIT,
  };
  const shape = catalog.tools.get_races;
  if (shape?.argNames.includes("order_by")) args.order_by = "race_number";
  if (shape?.argNames.includes("order")) args.order = "asc";
  assertToolArgs(catalog, "get_races", args);
  assertFields(catalog, "get_races", [...LIST_COLUMNS, "filters", "columns", "limit"]);
  const result = await bashira.callTool("get_races", args);
  if (!result.ok) throw new JobError(result.message, result.retryable);
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
