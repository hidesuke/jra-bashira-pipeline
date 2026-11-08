import { fetchBaba, babaFailure, type BabaBinding } from "./baba";
import { pageBlocks, pageTitle } from "./body";
import { chunkChildren } from "./notion-blocks";
import { ExternalBudget } from "./budget";
import { composeRemarks, fillCourseUser, fillRaceUser, mergeGoing } from "./dify-input";
import { readRacePrediction } from "./extract-prediction";
import { checkPredictionConsistency } from "./consistency";
import { buildFormTasks, finishQualifiedFetch, FORM_BATCH_SIZE, FORM_FETCH_LIMIT, horseFormSnapshots, planFormFetch, type FormTask } from "./form";
import { courseCallRecord, generateText, raceCallRecord } from "./gemini";
import { JobWriter, loadJob, type JobState } from "./job";
import { keys, sleepMs } from "./kv";
import { loadModels } from "./models";
import {
  assertDatabaseSchema,
  assertSelectValues,
  blocksIncludeBashira,
  decideNotionTarget,
  notionFetch,
  notionProperties,
  pageMatchesRace,
  type NotionSchema,
} from "./notion";
import { interpretOdds } from "./odds";
import { loadPrompt } from "./prompts";
import { numberField, rowsToObjects, stringField } from "./rows";
import { ambiguousNameMessage } from "./bashira/mcp";
import { savePredictInput } from "./predict-input";
import { renderUmabashira } from "./umabashira";
import type { BashiraPort } from "./bashira/port";
import { assertFields, assertToolArgs, catalogFromTools } from "./schema";
import { buildStatTasks, hydrateStatCache, writeStatCache, yearFrom } from "./stats";
import {
  errorMessage,
  isRetryable,
  JobError,
  EXTERNAL_BUDGET,
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
  /** 馬場 API のサービスバインディング。無いときは fetch。 */
  baba?: BabaBinding;
  fetch?: typeof fetch;
  log?(event: string, fields?: Record<string, unknown>): void;
  /** 同一ジョブキーの書き込み間隔。省略時は Date.now。 */
  clock?: () => number;
  /** KV の 429 バックオフと、書き込み間隔が足りないときの待ち。省略時は setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 1 配送で共有する。handleJobMessage が無ければ作る。 */
  jobWriter?: JobWriter;
  /** テストで Notion 段の外部呼び出し上限を下げる。未指定なら EXTERNAL_BUDGET。 */
  externalBudget?: number;
}

/** ページ ID を保存したあとの分割回数。Queue の max_retries では本文の続きを打ち切らない。 */
export const NOTION_CONTINUATION_LIMIT = 8;

const NOTION_CONTINUE_MESSAGE =
  "Notion 本文の差し替えがサブリクエスト上限に近づいたため、次の呼び出しで続けます";

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
  "birth_date",
  "career_starts",
  "prev_official_result",
  "prev_distance",
  "prev_surface",
  "days_since_last_race",
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
  const bound = bindWriter(deps);
  try {
    await dispatch(message, bound);
    return "ack";
  } catch (err) {
    if (await continueNotionLater(message, bound, err)) return "ack";
    const retry = isRetryable(err) && !isFinalAttempt(delivery);
    const persisted = await persistFailure(message, bound, err, retry);
    if (!retry && persisted) await releaseLock(bound.kv, raceKeyOf(message));
    bound.log?.("job_failed", {
      raceKey: raceKeyOf(message),
      retryable: retry,
      persisted,
      attempt: delivery?.attempt,
      error: errorMessage(err),
    });
    if (retry || !persisted) return "retry";
    return "ack";
  }
}

function bindWriter(deps: PipelineDeps): PipelineDeps {
  if (deps.jobWriter) return deps;
  return {
    ...deps,
    jobWriter: new JobWriter(deps.kv, deps.clock ?? Date.now, deps.sleep ?? sleepMs),
  };
}

function writer(deps: PipelineDeps): JobWriter {
  if (!deps.jobWriter) throw new Error("内部エラー: ジョブの書き込み口がありません");
  return deps.jobWriter;
}

async function commitJob(deps: PipelineDeps, state: JobState): Promise<void> {
  await writer(deps).flush(state);
}

async function checkpoint(deps: PipelineDeps, state: JobState): Promise<void> {
  try {
    await writer(deps).saveIfDue(state);
  } catch (err) {
    deps.log?.("job_checkpoint_failed", {
      raceKey: state.race.raceKey,
      saveError: errorMessage(err),
    });
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
  if (message.kind === "form") await runForm(state, deps);
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
      binding: deps.baba,
      fetcher: deps.fetch,
      log: deps.log,
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
  const formTasks = buildFormTasks(active, message.race, catalog);
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
    phase: formTasks.some((task) => task.status === "pending") ? "form" : tasks.some((task) => task.status === "pending") ? "stats" : "predict",
    remarks: message.remarks?.trim() ?? "",
    baba,
    raceRow,
    entries,
    formTasks,
    odds,
    courseVariant: null,
    statTasks: tasks,
    prediction: null,
    notionPageId: null,
    updatedAt: deps.now().toISOString(),
  };
  await commitJob(deps, state);
  await enqueuePhase(state, deps);
}

async function runForm(state: JobState, deps: PipelineDeps): Promise<void> {
  const tasks = state.formTasks ?? [];
  const pending = tasks.filter((task) => task.status === "pending");
  if (pending.length === 0) {
    state.phase = phaseAfterForm(state);
    state.updatedAt = deps.now().toISOString();
    await commitJob(deps, state);
    await enqueuePhase(state, deps);
    return;
  }
  const batch = pending.slice(0, FORM_BATCH_SIZE);
  let calls = 0;
  let heldForBudget = false;
  for (const task of batch) {
    if (calls >= FORM_FETCH_LIMIT) {
      heldForBudget = true;
      break;
    }
    calls += 1;
    const result = await deps.bashira.callTool("get_entries", task.args);
    if (!result.ok) throw await failFormCall(state, deps, result);
    const step = planFormFetch(task, result.data, state.race);
    if (step.kind === "requery") {
      if (calls >= FORM_FETCH_LIMIT) {
        heldForBudget = true;
        break;
      }
      calls += 1;
      const again = await deps.bashira.callTool("get_entries", step.args);
      if (!again.ok) throw await failFormCall(state, deps, again);
      assignFormTask(task, finishQualifiedFetch(task, again.data, state.race, step.qualifiedName, step.candidates));
    } else {
      assignFormTask(task, step.task);
    }
    state.updatedAt = deps.now().toISOString();
    await checkpoint(deps, state);
  }
  if (heldForBudget) {
    deps.log?.("form_fetch_budget", { raceKey: state.race.raceKey, calls, limit: FORM_FETCH_LIMIT });
  }
  state.phase = tasks.some((task) => task.status === "pending") ? "form" : phaseAfterForm(state);
  state.updatedAt = deps.now().toISOString();
  await commitJob(deps, state);
  await enqueuePhase(state, deps);
}

async function failFormCall(
  state: JobState,
  deps: PipelineDeps,
  result: { message: string; retryable: boolean; code: string },
): Promise<never> {
  state.updatedAt = deps.now().toISOString();
  try {
    await commitJob(deps, state);
  } catch (saveErr) {
    deps.log?.("job_checkpoint_failed", {
      raceKey: state.race.raceKey,
      error: result.message,
      saveError: errorMessage(saveErr),
    });
  }
  throw toolError(result);
}

function assignFormTask(target: FormTask, next: FormTask): void {
  target.status = next.status;
  target.rows = next.rows;
  target.note = next.note;
  target.resolution = next.resolution;
  if (next.facts) target.facts = next.facts;
}

function phaseAfterForm(state: JobState): JobState["phase"] {
  return state.statTasks.some((task) => task.status === "pending") ? "stats" : "predict";
}

async function runStats(state: JobState, deps: PipelineDeps): Promise<void> {
  const pending = state.statTasks.filter((task) => task.status === "pending");
  if (pending.length === 0) {
    state.phase = "predict";
    state.updatedAt = deps.now().toISOString();
    await commitJob(deps, state);
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
  await commitJob(deps, state);
  if (!result.ok) throw toolError(result);
  await enqueuePhase(state, deps);
}

async function runPredict(state: JobState, deps: PipelineDeps): Promise<void> {
  if (!state.prediction) {
    const budget = new ExternalBudget();
    const models = await loadModels(deps.kv, deps.config.defaultModel);
    const coursePrompt = await loadPrompt(deps.kv, "course");
    const racePrompt = await loadPrompt(deps.kv, "race");
    const surface = state.raceRow ? stringField(state.raceRow, "surface") : null;
    const distance = state.raceRow ? numberField(state.raceRow, "distance") : null;
    const going = mergeGoing({ raceRow: state.raceRow, baba: state.baba, surface });
    const course = await generateText({
      apiKey: deps.config.geminiApiKey,
      model: models.config.course,
      budget,
      fetcher: deps.fetch,
      tools: [{ googleSearch: {} }],
      system: coursePrompt.system,
      prompt: fillCourseUser(coursePrompt.user, {
        venue: state.race.venue,
        surface: surface ?? "不明",
        distance: distance == null ? "不明" : String(distance),
      }),
    });
    state.gemini = { ...state.gemini, course: courseCallRecord(course) };
    state.updatedAt = deps.now().toISOString();
    await commitJob(deps, state);
    const umabashira = renderUmabashira({ race: state.race, entries: state.entries, formTasks: state.formTasks ?? [] });
    const snapshots = horseFormSnapshots(state.entries, state.formTasks ?? []);
    const raceInput = fillRaceUser(racePrompt.user, {
      umabashira,
      course_analysis: course.text,
      weather: going.weather,
      condition: going.condition,
      remarks: composeRemarks(state.remarks ?? "", going.babaDetail, state.race),
    });
    const stored = await savePredictInput(deps.kv, {
      raceKey: state.race.raceKey,
      runId: state.runId,
      umabashira,
      raceInput,
      horses: snapshots,
    });
    state.predictInput = { stored: true, ...stored };
    const race = await generateText({
      apiKey: deps.config.geminiApiKey,
      model: models.config.race,
      budget,
      fetcher: deps.fetch,
      system: racePrompt.system,
      prompt: raceInput,
    });
    state.gemini = { ...state.gemini, race: raceCallRecord(race) };
    state.updatedAt = deps.now().toISOString();
    await commitJob(deps, state);
    const warnings = checkPredictionConsistency(race.text, snapshots);
    state.consistencyWarnings = warnings;
    if (warnings.length > 0) {
      deps.log?.("prediction_consistency", {
        raceKey: state.race.raceKey,
        count: warnings.length,
        warnings: warnings.map((warning) => warning.message),
      });
    }
    const fields = readRacePrediction(race.text);
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
  await commitJob(deps, state);
  await enqueuePhase(state, deps);
}

async function runNotion(state: JobState, deps: PipelineDeps): Promise<void> {
  if (!state.prediction || !state.odds) throw new JobError("予想結果が無いため Notion に書けません", false);
  const budget = new ExternalBudget(deps.externalBudget ?? EXTERNAL_BUDGET);
  const token = deps.config.notionToken;
  const databaseId = deps.config.notionDatabaseId;
  const raceName = state.raceRow ? stringField(state.raceRow, "race_name_main") : null;
  const grade = state.raceRow ? stringField(state.raceRow, "grade") : null;
  const properties = notionProperties({
    title: pageTitle(state.race, raceName, grade),
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
  if (state.notionPageId) {
    await resumeNotionPage(state, deps, budget, token, databaseId, children);
    return;
  }
  await publishNotionPage(state, deps, budget, token, databaseId, properties, children);
}

async function publishNotionPage(
  state: JobState,
  deps: PipelineDeps,
  budget: ExternalBudget,
  token: string,
  databaseId: string,
  properties: Record<string, unknown>,
  children: Array<Record<string, unknown>>,
): Promise<void> {
  ensureNotionRoom(budget);
  const schema = await notionOk(budget, token, `/databases/${databaseId}`, { method: "GET" }, deps.fetch);
  const options = assertDatabaseSchema(schema as NotionSchema);
  assertSelectValues(state.race, options);
  const storedId = await deps.kv.get(keys.notionPage(state.race.raceKey));
  const stored = storedId ? await readStoredPage(budget, token, storedId, state.race, deps.fetch) : null;
  const { pages, truncated } = await searchRacePages(budget, token, databaseId, state.race, deps.fetch);
  const marked = [];
  for (const page of pages) {
    marked.push({ id: page.id, isBashira: await pageHasBashiraMarker(budget, token, page.id, deps.fetch) });
  }
  const decision = decideNotionTarget({ stored, pages: marked, truncated });
  if (decision.action === "error") throw new JobError(decision.message, false);
  if (decision.action === "resume") throw new JobError("作成済みの Notion ページを再開できません", false);
  const oldId = decision.action === "update" ? decision.pageId : null;
  await createNotionPage(state, deps, budget, token, databaseId, properties, children, oldId);
  await appendRemaining(state, deps, budget, token, children);
  await archiveOldPage(state, deps, budget, token);
  await finishNotion(state, deps);
}

async function resumeNotionPage(
  state: JobState,
  deps: PipelineDeps,
  budget: ExternalBudget,
  token: string,
  databaseId: string,
  children: Array<Record<string, unknown>>,
): Promise<void> {
  const pageId = state.notionPageId;
  if (!pageId) throw new JobError("作成済みの Notion ページがありません", false);
  ensureNotionRoom(budget);
  const response = await notionFetch(budget, token, `/pages/${pageId}`, { method: "GET" }, deps.fetch);
  if (response.status === 404) throw new JobError("作成済みの Notion ページが見つかりません", false);
  if (response.status >= 400) throw notionStatus(response.status, response.body);
  if (pageIsTrashed(response.body)) throw new JobError("作成済みの Notion ページはアーカイブされています", false);
  if (!pageMatchesRace(response.body, state.race)) {
    throw new JobError("KV の Notion ページは日付・競馬場・レースが一致しません。別ページを推測しないので止めます", false);
  }
  const { pages, truncated } = await searchRacePages(budget, token, databaseId, state.race, deps.fetch);
  const decision = decideNotionTarget({
    stored: { id: pageId, found: true, matchesRace: true },
    pages: pages.map((page) => ({
      id: page.id,
      isBashira: page.id === pageId || page.id === state.notionArchivePageId,
    })),
    truncated,
    resumePageId: pageId,
  });
  if (decision.action === "error") throw new JobError(decision.message, false);
  if (decision.action !== "resume") throw new JobError("作成済みの Notion ページを再開できません", false);
  await deps.kv.put(keys.notionPage(state.race.raceKey), pageId);
  await appendRemaining(state, deps, budget, token, children);
  await archiveOldPage(state, deps, budget, token);
  await finishNotion(state, deps);
}

async function createNotionPage(
  state: JobState,
  deps: PipelineDeps,
  budget: ExternalBudget,
  token: string,
  databaseId: string,
  properties: Record<string, unknown>,
  children: Array<Record<string, unknown>>,
  oldId: string | null,
): Promise<void> {
  ensureNotionRoom(budget);
  const [first] = chunkChildren(children);
  const created = await notionOk(
    budget,
    token,
    "/pages",
    {
      method: "POST",
      body: JSON.stringify({ parent: { database_id: databaseId }, properties, children: first ?? [] }),
    },
    deps.fetch,
  );
  const id = (created as { id?: unknown }).id;
  if (typeof id !== "string") throw new JobError("Notion がページ ID を返しませんでした", true);
  state.notionPageId = id;
  state.notionArchivePageId = oldId;
  state.notionBlocksWritten = first?.length ?? 0;
  state.updatedAt = deps.now().toISOString();
  await commitJob(deps, state);
  await deps.kv.put(keys.notionPage(state.race.raceKey), id);
}

async function appendRemaining(
  state: JobState,
  deps: PipelineDeps,
  budget: ExternalBudget,
  token: string,
  children: Array<Record<string, unknown>>,
): Promise<void> {
  const pageId = state.notionPageId;
  if (!pageId) throw new JobError("Notion のページ ID がありません", false);
  const rest = children.slice(state.notionBlocksWritten ?? 0);
  for (const chunk of chunkChildren(rest)) {
    ensureNotionRoom(budget);
    await notionOk(
      budget,
      token,
      `/blocks/${pageId}/children`,
      { method: "PATCH", body: JSON.stringify({ children: chunk }) },
      deps.fetch,
    );
    state.notionBlocksWritten = (state.notionBlocksWritten ?? 0) + chunk.length;
    state.updatedAt = deps.now().toISOString();
    await commitJob(deps, state);
  }
}

async function archiveOldPage(
  state: JobState,
  deps: PipelineDeps,
  budget: ExternalBudget,
  token: string,
): Promise<void> {
  const oldId = state.notionArchivePageId;
  if (!oldId || oldId === state.notionPageId) return;
  ensureNotionRoom(budget);
  const response = await notionFetch(
    budget,
    token,
    `/pages/${oldId}`,
    { method: "PATCH", body: JSON.stringify({ archived: true }) },
    deps.fetch,
  );
  if (response.status !== 404 && response.status >= 400) throw notionStatus(response.status, response.body);
}

async function finishNotion(state: JobState, deps: PipelineDeps): Promise<void> {
  state.phase = "done";
  state.error = undefined;
  state.notionArchivePageId = null;
  state.updatedAt = deps.now().toISOString();
  await commitJob(deps, state);
  await releaseLock(deps.kv, state.race.raceKey);
}

function ensureNotionRoom(budget: ExternalBudget): void {
  if (budget.remaining < 1) throw new JobError(NOTION_CONTINUE_MESSAGE, true);
}

function isNotionBudgetStop(err: unknown): boolean {
  return err instanceof JobError && err.retryable && err.message.includes("サブリクエスト");
}

async function searchRacePages(
  budget: ExternalBudget,
  token: string,
  databaseId: string,
  race: RaceRef,
  fetcher?: typeof fetch,
): Promise<{ pages: Array<{ id: string }>; truncated: boolean }> {
  ensureNotionRoom(budget);
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
            { property: "日付", date: { equals: race.date } },
            { property: "競馬場", select: { equals: race.venue } },
            { property: "レース", select: { equals: String(race.raceNumber) } },
          ],
        },
      }),
    },
    fetcher,
  );
  const queryBody = query as { has_more?: boolean; results?: Array<{ id?: string }> };
  const results = queryBody.results ?? [];
  const pages = results.slice(0, 8).flatMap((result) => (result.id ? [{ id: result.id }] : []));
  return { pages, truncated: Boolean(queryBody.has_more) || results.length > 8 };
}

async function readStoredPage(
  budget: ExternalBudget,
  token: string,
  storedId: string,
  race: RaceRef,
  fetcher?: typeof fetch,
): Promise<{ id: string; found: boolean; matchesRace: boolean }> {
  ensureNotionRoom(budget);
  const page = await loadStoredPage(budget, token, storedId, race, fetcher);
  return page ?? { id: storedId, found: false, matchesRace: false };
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
  return { id: storedId, found: !pageIsTrashed(response.body), matchesRace: pageMatchesRace(response.body, race) };
}

function pageIsTrashed(page: unknown): boolean {
  if (!page || typeof page !== "object") return false;
  const record = page as { archived?: boolean; in_trash?: boolean };
  return Boolean(record.archived || record.in_trash);
}

async function pageHasBashiraMarker(
  budget: ExternalBudget,
  token: string,
  pageId: string,
  fetcher?: typeof fetch,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    ensureNotionRoom(budget);
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const children = await notionOk(budget, token, `/blocks/${pageId}/children?${query.toString()}`, { method: "GET" }, fetcher);
    const body = children as { results?: unknown; has_more?: boolean; next_cursor?: string | null };
    if (blocksIncludeBashira(body.results)) return true;
    if (!body.has_more || !body.next_cursor) return false;
    cursor = body.next_cursor;
  }
  return false;
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
  if (state.phase === "form") {
    await deps.enqueue({ kind: "form", runId: state.runId, raceKey: state.race.raceKey });
  } else if (state.phase === "stats") {
    await deps.enqueue({ kind: "stats", runId: state.runId, raceKey: state.race.raceKey });
  } else if (state.phase === "predict") {
    await deps.enqueue({ kind: "predict", runId: state.runId, raceKey: state.race.raceKey });
  } else if (state.phase === "notion") {
    await deps.enqueue({ kind: "notion", runId: state.runId, raceKey: state.race.raceKey });
  }
}

/**
 * ページ ID を保存したあとの予算切れは、Queue の最終試行でも phase=error にしない。
 * 新しい notion メッセージを積む（attempts は 1 から）。旧ページはまだアーカイブしない。
 */
async function continueNotionLater(message: JobMessage, deps: PipelineDeps, err: unknown): Promise<boolean> {
  if (message.kind !== "notion" || !isNotionBudgetStop(err)) return false;
  const state = await loadJob(deps.kv, message.raceKey);
  if (!state || state.runId !== message.runId || state.phase === "done" || state.phase === "error") return false;
  if (!state.notionPageId) return false;
  const next = (state.notionContinuations ?? 0) + 1;
  if (next > NOTION_CONTINUATION_LIMIT) return false;
  state.notionContinuations = next;
  state.updatedAt = deps.now().toISOString();
  await commitJob(deps, state);
  await deps.enqueue({ kind: "notion", runId: state.runId, raceKey: state.race.raceKey });
  deps.log?.("notion_continue", { raceKey: state.race.raceKey, continuations: next });
  return true;
}

/** 失敗理由をジョブに残す。保存自体が失敗しても投げず、元のエラーを隠さない。 */
async function persistFailure(message: JobMessage, deps: PipelineDeps, err: unknown, retry: boolean): Promise<boolean> {
  const text = errorMessage(err);
  try {
    const raceKey = raceKeyOf(message);
    const state = await loadJob(deps.kv, raceKey);
    const updatedAt = deps.now().toISOString();
    if (!state || (message.kind === "start" && state.runId !== message.runId)) {
      if (message.kind !== "start") return true;
      await commitJob(deps, {
        runId: message.runId,
        race: message.race,
        requestedBy: message.requestedBy,
        phase: retry ? "collect" : "error",
        error: retry ? undefined : text,
        remarks: message.remarks?.trim() ?? "",
        baba: null,
        raceRow: null,
        entries: [],
        formTasks: [],
        odds: null,
        courseVariant: null,
        statTasks: [],
        prediction: null,
        notionPageId: null,
        updatedAt,
      });
      return true;
    }
    if (state.runId !== runIdOf(message)) return true;
    // 再試行中で進捗はもう書いてある。同じキーを直後に上書きしない。
    if (retry && writer(deps).hasWritten()) return true;
    state.updatedAt = updatedAt;
    if (!retry) {
      state.phase = "error";
      state.error = text;
    }
    await commitJob(deps, state);
    return true;
  } catch (saveErr) {
    deps.log?.("job_persist_failed", {
      raceKey: raceKeyOf(message),
      error: text,
      saveError: errorMessage(saveErr),
    });
    return false;
  }
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
