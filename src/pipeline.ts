import { fetchBaba, babaFailure } from "./baba";
import { pageBlocks, pageTitle } from "./body";
import { ExternalBudget } from "./budget";
import { generateText, parseRacePrediction } from "./gemini";
import { loadJob, saveJob, type JobState } from "./job";
import { keys } from "./kv";
import { loadModels } from "./models";
import {
  assertDatabaseSchema,
  assertSelectValues,
  decideNotionTarget,
  firstParagraphIsBashira,
  notionFetch,
  notionProperties,
  pageMatchesRace,
  type NotionSchema,
} from "./notion";
import { interpretOdds } from "./odds";
import { loadPrompt, renderPrompt } from "./prompts";
import { numberField, rowsToObjects, stringField } from "./rows";
import { ambiguousNameMessage } from "./bashira/mcp";
import type { BashiraPort } from "./bashira/port";
import { assertFields, assertToolArgs, catalogFromTools } from "./schema";
import { buildStatTasks, hydrateStatCache, writeStatCache, yearFrom } from "./stats";
import {
  errorMessage,
  isRetryable,
  JobError,
  LOCK_TTL_SECONDS,
  STATS_BATCH_SIZE,
  type JobMessage,
  type KvStore,
  type RaceRef,
} from "./types";

export interface AppConfig {
  babaUrl: string;
  geminiApiKey: string;
  notionToken: string;
  notionDatabaseId: string;
  statsPeriodYears: number;
  statsMinStarts: number;
  broodmareMinStarts: number;
  defaultModel: string;
}

export interface PipelineDeps {
  kv: KvStore;
  config: AppConfig;
  bashira: BashiraPort;
  enqueue(message: JobMessage): Promise<void>;
  now(): Date;
  fetch?: typeof fetch;
  log?(event: string, fields?: Record<string, unknown>): void;
}

const RACE_COLUMNS = [
  "race_id",
  "race_status",
  "race_meeting_date",
  "race_track",
  "race_number",
  "race_name_main",
  "grade",
  "race_condition",
  "race_type",
  "surface",
  "distance",
  "track_condition",
  "weather",
  "starters",
  "scheduled_horse_count",
  "rail_type",
  "weight_type",
  "post_time",
  "odds_observed_at",
];

const ENTRY_COLUMNS = [
  "horse_number",
  "horse_name",
  "horse_sex",
  "horse_age",
  "bracket_number",
  "jockey_name",
  "trainer_name",
  "weight_to_carry_kg",
  "horse_weight",
  "sire_name",
  "broodmare_sire_name",
  "win_odds",
  "win_odds_rank",
  "odds_kind",
  "odds_observed_at",
  "race_abnormality",
  "entry_status",
];

const SCRATCHED = new Set(["出走取消", "発走除外", "競走除外"]);

export interface Delivery {
  /** Queue の attempts。1 始まり。 */
  attempt: number;
  /** wrangler.jsonc の max_retries。この回数に達した配送で打ち切る。 */
  maxRetries: number;
}

export async function handleJobMessage(
  message: JobMessage,
  deps: PipelineDeps,
  delivery?: Delivery,
): Promise<"ack" | "retry"> {
  try {
    await dispatch(message, deps);
    return "ack";
  } catch (err) {
    const retry = isRetryable(err) && !isFinalAttempt(delivery);
    await persistFailure(message, deps, err, retry);
    if (!retry) await releaseLock(deps.kv, raceKeyOf(message));
    deps.log?.("job_failed", {
      raceKey: raceKeyOf(message),
      retryable: retry,
      attempt: delivery?.attempt,
      error: errorMessage(err),
    });
    return retry ? "retry" : "ack";
  }
}

function isFinalAttempt(delivery: Delivery | undefined): boolean {
  if (!delivery) return false;
  return delivery.attempt >= delivery.maxRetries;
}

async function dispatch(message: JobMessage, deps: PipelineDeps): Promise<void> {
  if (message.kind === "start") {
    const existing = await loadJob(deps.kv, message.race.raceKey);
    if (existing?.runId === message.runId && (existing.phase === "error" || existing.phase === "done")) return;
    if (existing?.runId === message.runId && existing.phase !== "collect") {
      await enqueuePhase(existing, deps);
      return;
    }
    await collect(message, deps);
    return;
  }
  const state = await loadJob(deps.kv, message.raceKey);
  if (!state || state.runId !== message.runId || state.phase === "done" || state.phase === "error") return;
  if (message.kind === "stats") await runStats(state, deps);
  if (message.kind === "predict") await runPredict(state, deps);
  if (message.kind === "notion") await runNotion(state, deps);
}

async function collect(message: Extract<JobMessage, { kind: "start" }>, deps: PipelineDeps): Promise<void> {
  const budget = new ExternalBudget();
  let baba: JobState["baba"];
  try {
    baba = await fetchBaba({
      url: deps.config.babaUrl,
      venue: message.race.venue,
      budget,
      fetcher: deps.fetch,
    });
  } catch (err) {
    baba = babaFailure(err);
  }
  const listed = await deps.bashira.listTools();
  if (!listed.ok) throw toolError(listed);
  const catalog = catalogFromTools(listed.tools);
  const raceArgs = {
    filters: {
      race_meeting_date: { gte: message.race.date, lte: message.race.date },
      race_track: message.race.venue,
      race_number: message.race.raceNumber,
    },
    columns: RACE_COLUMNS,
    limit: 5,
  };
  assertToolArgs(catalog, "get_races", raceArgs);
  assertFields(catalog, "get_races", ["filters", "columns", "limit", ...RACE_COLUMNS, "race_meeting_date", "race_track", "race_number"]);
  const racePayload = await call(deps, "get_races", raceArgs);
  if (racePayload && typeof racePayload === "object" && (racePayload as { truncated?: unknown }).truncated === true) {
    throw new JobError("get_races の結果が打ち切られたため、レースを特定できません", false);
  }
  const raceRows = rowsToObjects(racePayload);
  if (raceRows.length !== 1) {
    throw new JobError(`レースが ${raceRows.length} 件返ったため特定できません。推測しません`, false);
  }
  assertNoAmbiguity(racePayload);
  const raceRow = raceRows[0]!;
  if (stringField(raceRow, "race_status") === "canceled") {
    throw new JobError("中止レースのため予想しません", false);
  }
  const surface = stringField(raceRow, "surface");
  const distance = numberField(raceRow, "distance");
  if (!surface || distance == null) {
    throw new JobError("レースの馬場種類または距離が無いため、コース成績を作れません", false);
  }
  const entryArgs = {
    filters: {
      race_meeting_date: { gte: message.race.date, lte: message.race.date },
      race_track: message.race.venue,
      race_number: message.race.raceNumber,
    },
    columns: ENTRY_COLUMNS,
    limit: 50,
    order_by: "horse_number",
    order: "asc",
  };
  assertToolArgs(catalog, "get_entries", entryArgs);
  assertFields(catalog, "get_entries", ["filters", "columns", "limit", "order_by", "order", ...ENTRY_COLUMNS]);
  const entryPayload = await call(deps, "get_entries", entryArgs);
  if (entryPayload && typeof entryPayload === "object" && (entryPayload as { truncated?: unknown }).truncated === true) {
    throw new JobError("出馬表が打ち切られました。頭数が足りないまま予想しません", false);
  }
  assertNoAmbiguity(entryPayload);
  const entries = rowsToObjects(entryPayload);
  if (entries.length === 0) throw new JobError("出馬表が空です", false);
  const oddsArgs = { race_id: message.race.raceId, bet_type: "win", limit: 50 };
  assertToolArgs(catalog, "get_odds", oddsArgs);
  const oddsCall = await deps.bashira.callTool("get_odds", oddsArgs);
  if (!oddsCall.ok && (oddsCall.code === "auth" || oddsCall.code === "budget")) throw toolError(oddsCall);
  const odds = interpretOdds({
    getOdds: oddsCall.ok ? { ok: true, payload: oddsCall.data } : { ok: false, message: oddsCall.message },
    entryRows: entries,
    now: deps.now(),
  });
  const active = entries.filter((row) => !SCRATCHED.has(stringField(row, "race_abnormality") ?? ""));
  const tasks = buildStatTasks(
    {
      venue: message.race.venue,
      surface,
      distance,
      yearFrom: yearFrom(Number(message.race.date.slice(0, 4)), deps.config.statsPeriodYears),
      minStarts: deps.config.statsMinStarts,
      broodmareMinStarts: deps.config.broodmareMinStarts,
      sires: uniqueNames(active, "sire_name"),
      broodmareSires: uniqueNames(active, "broodmare_sire_name"),
      jockeys: uniqueNames(active, "jockey_name"),
    },
    catalog,
  );
  await hydrateStatCache(tasks, deps.kv);
  const state: JobState = {
    runId: message.runId,
    race: message.race,
    requestedBy: message.requestedBy,
    phase: tasks.some((task) => task.status === "pending") ? "stats" : "predict",
    baba,
    raceRow,
    entries,
    odds,
    courseVariant: null,
    statTasks: tasks,
    prediction: null,
    notionPageId: null,
    updatedAt: deps.now().toISOString(),
  };
  await saveJob(deps.kv, state);
  await enqueuePhase(state, deps);
}

async function runStats(state: JobState, deps: PipelineDeps): Promise<void> {
  const pending = state.statTasks.filter((task) => task.status === "pending");
  if (pending.length === 0) {
    state.phase = "predict";
    state.updatedAt = deps.now().toISOString();
    await saveJob(deps.kv, state);
    await enqueuePhase(state, deps);
    return;
  }
  const batch = pending.slice(0, STATS_BATCH_SIZE);
  const result = await deps.bashira.callTools(batch.map((task) => ({ name: "get_stats", args: task.args })));
  const done = result.results ?? [];
  for (let index = 0; index < done.length; index += 1) {
    const payload = done[index];
    const ambiguity = ambiguousNameMessage(payload);
    if (ambiguity) throw new JobError(ambiguity, false);
    const task = batch[index]!;
    task.status = "done";
    task.result = payload;
    const rows = rowsToObjects(payload);
    if (rows.length === 0) task.note = "該当なし、または min_starts 未満";
    await writeStatCache(task, deps.kv, deps.now().toISOString());
  }
  state.updatedAt = deps.now().toISOString();
  state.phase = state.statTasks.some((task) => task.status === "pending") ? "stats" : "predict";
  await saveJob(deps.kv, state);
  if (!result.ok) throw toolError(result);
  await enqueuePhase(state, deps);
}

async function runPredict(state: JobState, deps: PipelineDeps): Promise<void> {
  if (!state.prediction) {
    const budget = new ExternalBudget();
    const models = await loadModels(deps.kv, deps.config.defaultModel);
    const coursePrompt = await loadPrompt(deps.kv, "course");
    const racePrompt = await loadPrompt(deps.kv, "race");
    const course = await generateText({
      apiKey: deps.config.geminiApiKey,
      model: models.config.course,
      budget,
      fetcher: deps.fetch,
      prompt: renderPrompt(coursePrompt, {
        course_variant: null,
        course_variant_note: "内・外コースのデータは無い",
        race: state.race,
        race_row: state.raceRow,
        baba: state.baba,
        stats: state.statTasks.map((task) => ({
          id: task.id,
          label: task.label,
          note: task.note ?? null,
          result: task.result ?? null,
        })),
      }),
    });
    const race = await generateText({
      apiKey: deps.config.geminiApiKey,
      model: models.config.race,
      budget,
      fetcher: deps.fetch,
      json: true,
      prompt: renderPrompt(racePrompt, {
        course_variant: null,
        course_analysis: course.text,
        course_model_version: course.modelVersion,
        race: state.race,
        race_row: state.raceRow,
        entries: state.entries,
        odds: state.odds,
        baba: state.baba,
      }),
    });
    const fields = parseRacePrediction(race.text);
    state.prediction = {
      courseText: course.text,
      courseModel: models.config.course,
      raceModel: models.config.race,
      courseModelVersion: course.modelVersion,
      raceModelVersion: race.modelVersion,
      coursePromptVersion: coursePrompt.version,
      racePromptVersion: racePrompt.version,
      ...fields,
    };
  }
  state.phase = "notion";
  state.updatedAt = deps.now().toISOString();
  await saveJob(deps.kv, state);
  await enqueuePhase(state, deps);
}

async function runNotion(state: JobState, deps: PipelineDeps): Promise<void> {
  if (!state.prediction || !state.odds) throw new JobError("予想結果が無いため Notion に書けません", false);
  const budget = new ExternalBudget();
  const token = deps.config.notionToken;
  const databaseId = deps.config.notionDatabaseId;
  const schema = await notionOk(budget, token, `/databases/${databaseId}`, { method: "GET" }, deps.fetch);
  const options = assertDatabaseSchema(schema as NotionSchema);
  assertSelectValues(state.race, options);
  const storedId = await deps.kv.get(keys.notionPage(state.race.raceKey));
  const stored = await loadStoredPage(budget, token, storedId, state.race, deps.fetch);
  const query = await notionOk(
    budget,
    token,
    `/databases/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        page_size: 20,
        filter: {
          and: [
            { property: "日付", date: { equals: state.race.date } },
            { property: "競馬場", select: { equals: state.race.venue } },
            { property: "レース", select: { equals: String(state.race.raceNumber) } },
          ],
        },
      }),
    },
    deps.fetch,
  );
  const queryBody = query as { has_more?: boolean; results?: Array<{ id?: string }> };
  const results = queryBody.results ?? [];
  const truncated = Boolean(queryBody.has_more) || results.length > 8;
  const pages = [];
  for (const result of results.slice(0, 8)) {
    if (!result.id) continue;
    const children = await notionOk(
      budget,
      token,
      `/blocks/${result.id}/children?page_size=5`,
      { method: "GET" },
      deps.fetch,
    );
    const blocks = (children as { results?: unknown }).results;
    pages.push({ id: result.id, isBashira: firstParagraphIsBashira(blocks) });
  }
  const decision = decideNotionTarget({ stored, pages, truncated });
  if (decision.action === "error") throw new JobError(decision.message, false);
  const raceName = state.raceRow ? stringField(state.raceRow, "race_name_main") : null;
  const properties = notionProperties({
    title: pageTitle(state.race, raceName),
    race: state.race,
    指数分布: state.prediction.指数分布,
    自信度: state.prediction.自信度,
    波乱度: state.prediction.波乱度,
  });
  const children = pageBlocks({
    race: state.race,
    raceName,
    requestedBy: state.requestedBy,
    odds: state.odds,
    courseModel: state.prediction.courseModel,
    raceModel: state.prediction.raceModel,
    courseModelVersion: state.prediction.courseModelVersion,
    raceModelVersion: state.prediction.raceModelVersion,
    coursePromptVersion: state.prediction.coursePromptVersion,
    racePromptVersion: state.prediction.racePromptVersion,
    印: state.prediction.印,
    予想本文: state.prediction.予想本文,
    courseText: state.prediction.courseText,
  });
  let pageId: string;
  if (decision.action === "create") {
    const created = await notionOk(
      budget,
      token,
      "/pages",
      { method: "POST", body: JSON.stringify({ parent: { database_id: databaseId }, properties, children }) },
      deps.fetch,
    );
    const id = (created as { id?: unknown }).id;
    if (typeof id !== "string") throw new JobError("Notion がページ ID を返しませんでした", true);
    pageId = id;
  } else {
    pageId = decision.pageId;
    await notionOk(budget, token, `/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) }, deps.fetch);
    await replaceChildren(budget, token, pageId, children, deps.fetch);
  }
  await deps.kv.put(keys.notionPage(state.race.raceKey), pageId);
  state.notionPageId = pageId;
  state.phase = "done";
  state.error = undefined;
  state.updatedAt = deps.now().toISOString();
  await saveJob(deps.kv, state);
  await releaseLock(deps.kv, state.race.raceKey);
}

async function loadStoredPage(
  budget: ExternalBudget,
  token: string,
  storedId: string | null,
  race: RaceRef,
  fetcher?: typeof fetch,
): Promise<{ id: string; found: boolean; matchesRace: boolean } | null> {
  if (!storedId) return null;
  const response = await notionFetch(budget, token, `/pages/${storedId}`, { method: "GET" }, fetcher);
  if (response.status === 404) return { id: storedId, found: false, matchesRace: false };
  if (response.status >= 400) throw notionStatus(response.status, response.body);
  const archived = Boolean((response.body as { archived?: boolean }).archived);
  return { id: storedId, found: !archived, matchesRace: pageMatchesRace(response.body, race) };
}

async function replaceChildren(
  budget: ExternalBudget,
  token: string,
  pageId: string,
  children: Array<Record<string, unknown>>,
  fetcher?: typeof fetch,
): Promise<void> {
  for (;;) {
    if (budget.remaining < 3) {
      throw new JobError("Notion 本文の差し替えがサブリクエスト上限に近づいたため、次の呼び出しで続けます", true);
    }
    const listed = await notionOk(budget, token, `/blocks/${pageId}/children?page_size=20`, { method: "GET" }, fetcher);
    const blocks = ((listed as { results?: Array<{ id?: string }> }).results ?? []).filter((block) => block.id);
    if (blocks.length === 0) break;
    for (const block of blocks) {
      if (budget.remaining < 2) {
        throw new JobError("Notion 本文の差し替えがサブリクエスト上限に近づいたため、次の呼び出しで続けます", true);
      }
      const removed = await notionFetch(budget, token, `/blocks/${block.id}`, { method: "DELETE" }, fetcher);
      if (removed.status >= 400 && removed.status !== 404) throw notionStatus(removed.status, removed.body);
    }
  }
  for (let index = 0; index < children.length; index += 50) {
    const chunk = children.slice(index, index + 50);
    await notionOk(
      budget,
      token,
      `/blocks/${pageId}/children`,
      { method: "PATCH", body: JSON.stringify({ children: chunk }) },
      fetcher,
    );
  }
}

async function notionOk(
  budget: ExternalBudget,
  token: string,
  path: string,
  init: RequestInit,
  fetcher?: typeof fetch,
): Promise<unknown> {
  const response = await notionFetch(budget, token, path, init, fetcher);
  if (response.status >= 400) throw notionStatus(response.status, response.body);
  return response.body;
}

function notionStatus(status: number, body: unknown): JobError {
  const message =
    body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : "";
  return new JobError(`Notion HTTP ${status}${message ? `: ${message}` : ""}`, status === 429 || status >= 500);
}

async function call(deps: PipelineDeps, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await deps.bashira.callTool(name, args);
  if (!result.ok) throw toolError(result);
  assertNoAmbiguity(result.data);
  return result.data;
}

function toolError(result: { message: string; retryable: boolean; code: string }): JobError {
  return new JobError(result.message, result.code === "auth" ? false : result.retryable);
}

function assertNoAmbiguity(payload: unknown): void {
  const message = ambiguousNameMessage(payload);
  if (message) throw new JobError(message, false);
}

async function enqueuePhase(state: JobState, deps: PipelineDeps): Promise<void> {
  if (state.phase === "stats") {
    await deps.enqueue({ kind: "stats", runId: state.runId, raceKey: state.race.raceKey });
  } else if (state.phase === "predict") {
    await deps.enqueue({ kind: "predict", runId: state.runId, raceKey: state.race.raceKey });
  } else if (state.phase === "notion") {
    await deps.enqueue({ kind: "notion", runId: state.runId, raceKey: state.race.raceKey });
  }
}

async function persistFailure(message: JobMessage, deps: PipelineDeps, err: unknown, retry: boolean): Promise<void> {
  const raceKey = raceKeyOf(message);
  const state = await loadJob(deps.kv, raceKey);
  const text = errorMessage(err);
  const updatedAt = deps.now().toISOString();
  if (!state || (message.kind === "start" && state.runId !== message.runId)) {
    if (message.kind !== "start") return;
    await saveJob(deps.kv, {
      runId: message.runId,
      race: message.race,
      requestedBy: message.requestedBy,
      phase: retry ? "collect" : "error",
      error: retry ? undefined : text,
      baba: null,
      raceRow: null,
      entries: [],
      odds: null,
      courseVariant: null,
      statTasks: [],
      prediction: null,
      notionPageId: null,
      updatedAt,
    });
    return;
  }
  if (state.runId !== runIdOf(message)) return;
  state.updatedAt = updatedAt;
  if (!retry) {
    state.phase = "error";
    state.error = text;
  }
  await saveJob(deps.kv, state);
}

async function releaseLock(kv: KvStore, raceKey: string): Promise<void> {
  await kv.delete(keys.lock(raceKey));
}

/** ロックが残っていても、終了済み・失敗済み・更新が止まったジョブは進行中にしない。 */
export function blocksNewRun(
  job: { phase: string; error?: string; updatedAt: string } | null,
  nowMs: number,
): boolean {
  if (!job) return true;
  if (job.phase === "error" || job.phase === "done") return false;
  if (job.error) return false;
  const updated = Date.parse(job.updatedAt);
  if (!Number.isFinite(updated) || nowMs - updated > LOCK_TTL_SECONDS * 1000) return false;
  return true;
}

export async function acquireLock(
  kv: KvStore,
  raceKey: string,
  runId: string,
  requestedBy: string,
  now: Date,
): Promise<boolean> {
  const current = await kv.get(keys.lock(raceKey));
  if (current) {
    let expiresAt = 0;
    try {
      expiresAt = (JSON.parse(current) as { expiresAt?: number }).expiresAt ?? 0;
    } catch {
      expiresAt = 0;
    }
    const lockFresh = expiresAt > now.getTime();
    if (lockFresh && blocksNewRun(await loadJob(kv, raceKey), now.getTime())) return false;
  }
  await kv.put(
    keys.lock(raceKey),
    JSON.stringify({ runId, requestedBy, expiresAt: now.getTime() + LOCK_TTL_SECONDS * 1000 }),
    { expirationTtl: LOCK_TTL_SECONDS },
  );
  return true;
}

function raceKeyOf(message: JobMessage): string {
  return message.kind === "start" ? message.race.raceKey : message.raceKey;
}

function runIdOf(message: JobMessage): string {
  return message.runId;
}

function uniqueNames(rows: Record<string, unknown>[], key: string): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const value = stringField(row, key);
    if (value) names.add(value);
  }
  return [...names];
}
