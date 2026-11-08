import { identifyCaller, type Caller } from "./access";
import type { ConsistencyWarning } from "./consistency";
import { horseFormSnapshots, type HorseFormSnapshot } from "./form";
import type { CourseGeminiCall, GeminiCallRecord, GeminiUsageMetadata } from "./gemini";
import { handleInspect } from "./inspect";
import { pastRunsSnapshotFields } from "./input-sections";
import { jobRetryView, loadJob } from "./job";
import { loadPredictInput } from "./predict-input";
import {
  applyModelUpdate,
  assertModelsAllowed,
  listGenerateContentModels,
  loadModelHistory,
  loadModels,
  restoreModelUpdate,
  saveModelState,
} from "./models";
import { runDateBatch } from "./batch";
import type { BashiraPort } from "./bashira/port";
import { enqueueRace } from "./enqueue";
import type { AppConfig } from "./pipeline";
import { parseRaceRequest } from "./race-ref";
import { JobError, errorMessage, type JobMessage, type KvStore } from "./types";
import { APP_VERSION } from "./version";
import type { JWTPayload } from "jose";
import { ExternalBudget } from "./budget";

export interface HttpConfig extends AppConfig {
  accessTeamDomain: string;
  accessAud: string;
  accessClientIdGrok: string;
  accessClientIdMuse: string;
}

export interface OAuthPort {
  getStatus(): Promise<{
    registered: boolean;
    authorized: boolean;
    needsReauth: boolean;
    expiresAt: string | null;
    lastError: string | null;
  }>;
  beginAuthorization(redirectUri: string): Promise<{ url: string }>;
  completeAuthorization(input: { code: string; state: string; iss: string | null }): Promise<{ ok: true }>;
}

export interface HttpDeps {
  config: HttpConfig;
  kv: KvStore;
  enqueue(message: JobMessage): Promise<void>;
  now(): Date;
  fetch?: typeof fetch;
  verifyJwt(token: string): Promise<JWTPayload>;
  oauth: OAuthPort;
  /** 開催日バッチが BASHIRA を呼ぶ。無いルートでは使わない。 */
  bashira?: BashiraPort;
  log?(event: string, fields?: Record<string, unknown>): void;
  /** Workers の version metadata。tag が空のときは buildCommit を見る。 */
  version?: { id: string; tag: string; timestamp: string } | null;
  /** scripts/write-build-info.mjs が WORKERS_CI_COMMIT_SHA から埋め込んだ SHA。 */
  buildCommit?: string | null;
}

function commitOf(deps: HttpDeps): string | null {
  const tag = deps.version?.tag?.trim() ?? "";
  if (tag) return tag;
  const built = deps.buildCommit?.trim() ?? "";
  return built || null;
}

export async function handleRequest(request: Request, deps: HttpDeps): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        mode: "next-day-batch",
        version: APP_VERSION,
        commit: commitOf(deps),
        version_id: deps.version?.id || null,
      });
    }
    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      return await oauthCallback(url, deps);
    }
    if (request.method === "GET" && url.pathname === "/oauth/start") {
      await requireCaller(request, deps);
      const redirectUri = new URL("/oauth/callback", url.origin).toString();
      const started = await deps.oauth.beginAuthorization(redirectUri);
      return Response.redirect(started.url, 302);
    }
    if (request.method === "GET" && url.pathname === "/oauth/status") {
      await requireCaller(request, deps);
      return json(await deps.oauth.getStatus());
    }
    if (request.method === "POST" && url.pathname === "/run") {
      const caller = await requireCaller(request, deps);
      return await runOne(request, caller, deps);
    }
    if (url.pathname === "/admin/models" && request.method === "GET") {
      const caller = await requireCaller(request, deps);
      return await getModels(deps, caller);
    }
    if (url.pathname === "/admin/models" && request.method === "PUT") {
      const caller = await requireCaller(request, deps);
      return await putModels(request, deps, caller);
    }
    if (url.pathname === "/admin/models/restore" && request.method === "POST") {
      const caller = await requireCaller(request, deps);
      return await restoreModels(deps, caller);
    }
    if (url.pathname === "/admin/jobs" && request.method === "GET") {
      await requireCaller(request, deps);
      return await getJob(url, deps);
    }
    if (url.pathname === "/admin/jobs/input" && request.method === "GET") {
      await requireCaller(request, deps);
      return await getJobInput(url, deps);
    }
    if (url.pathname === "/admin/inspect" && request.method === "GET") {
      await requireCaller(request, deps);
      return await handleInspect(url, deps.kv);
    }
    if (url.pathname === "/admin/batch" && request.method === "POST") {
      const caller = await requireCaller(request, deps);
      return await postBatch(request, caller, deps);
    }
    return json({ error: "not found" }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof JobError) return json({ error: err.message }, 400);
    return json({ error: errorMessage(err) }, 500);
  }
}

async function runOne(request: Request, caller: Caller, deps: HttpDeps): Promise<Response> {
  const body = await readJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new JobError("JSON オブジェクトでレースを 1 件指定してください", false);
  }
  const race = parseRaceRequest(body);
  const remarks = typeof (body as { remarks?: unknown }).remarks === "string" ? (body as { remarks: string }).remarks.trim() : "";
  const queued = await enqueueRace(deps, { race, requestedBy: caller.name, remarks });
  if (!queued.enqueued) {
    return json({ error: "このレースは処理中です", race_key: race.raceKey }, 409);
  }
  return json(
    { enqueued: true, race_key: race.raceKey, run_id: queued.runId, requested_by: caller.name },
    202,
  );
}

async function postBatch(request: Request, caller: Caller, deps: HttpDeps): Promise<Response> {
  if (!deps.bashira) throw new HttpError(500, "BASHIRA の接続がありません");
  const body = await readJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new JobError("JSON オブジェクトで date を指定してください", false);
  }
  const record = body as { date?: unknown; dry_run?: unknown };
  if (typeof record.date !== "string") throw new JobError("date は YYYY-MM-DD です", false);
  if (record.dry_run != null && typeof record.dry_run !== "boolean") {
    throw new JobError("dry_run は true または false です", false);
  }
  const summary = await runDateBatch(
    {
      kv: deps.kv,
      bashira: deps.bashira,
      enqueue: deps.enqueue,
      now: deps.now,
      log: deps.log,
    },
    {
      date: record.date,
      source: "admin",
      dryRun: record.dry_run === true,
      requestedBy: caller.name,
    },
  );
  return json(summary);
}

async function getModels(deps: HttpDeps, _caller: Caller): Promise<Response> {
  const budget = new ExternalBudget();
  const [models, current, history] = await Promise.all([
    listGenerateContentModels({
      kv: deps.kv,
      apiKey: deps.config.geminiApiKey,
      budget,
      now: deps.now(),
      fetcher: deps.fetch,
    }),
    loadModels(deps.kv, deps.config.defaultModel),
    loadModelHistory(deps.kv),
  ]);
  return json({
    note: "course はコース分析、race はレース予想に使う Gemini モデルです。",
    current: current.config,
    source: current.source,
    previous: history.previous,
    history_count: history.history.length,
    models,
  });
}

async function putModels(request: Request, deps: HttpDeps, caller: Caller): Promise<Response> {
  const body = (await readJson(request)) as { course?: unknown; race?: unknown };
  const patch: { course?: string; race?: string } = {};
  if (body.course != null) {
    if (typeof body.course !== "string") throw new JobError("course は文字列です", false);
    patch.course = body.course;
  }
  if (body.race != null) {
    if (typeof body.race !== "string") throw new JobError("race は文字列です", false);
    patch.race = body.race;
  }
  const budget = new ExternalBudget();
  const allowed = await listGenerateContentModels({
    kv: deps.kv,
    apiKey: deps.config.geminiApiKey,
    budget,
    now: deps.now(),
    fetcher: deps.fetch,
  });
  const names = new Set(allowed.map((model) => model.name));
  const current = await loadModels(deps.kv, deps.config.defaultModel);
  const history = await loadModelHistory(deps.kv);
  const next = applyModelUpdate({
    current: current.config,
    history: history.history,
    patch,
    caller: caller.name,
    clientId: caller.clientId,
    now: deps.now(),
  });
  assertModelsAllowed(next.current, names);
  await saveModelState(deps.kv, next);
  return json({
    note: "モデルを更新しました。履歴には変更前、変更後、呼び出し元、日本時間を残しています。",
    current: next.current,
    previous: next.previous,
    caller: caller.name,
  });
}

async function restoreModels(deps: HttpDeps, caller: Caller): Promise<Response> {
  const current = await loadModels(deps.kv, deps.config.defaultModel);
  const history = await loadModelHistory(deps.kv);
  const next = restoreModelUpdate({
    current: current.config,
    previous: history.previous,
    history: history.history,
    caller: caller.name,
    clientId: caller.clientId,
    now: deps.now(),
  });
  await saveModelState(deps.kv, next);
  return json({
    note: "直前のモデル設定に戻しました。",
    current: next.current,
    previous: next.previous,
    caller: caller.name,
  });
}

async function getJob(url: URL, deps: HttpDeps): Promise<Response> {
  const raceKey = url.searchParams.get("race_key");
  if (!raceKey) throw new JobError("race_key を指定してください", false);
  const state = await loadJob(deps.kv, raceKey);
  if (!state) return json({ error: "ジョブがありません", race_key: raceKey }, 404);
  const retry = jobRetryView(state.retry);
  return json({
    race_key: state.race.raceKey,
    run_id: state.runId,
    phase: state.phase,
    error: state.error ?? null,
    retry: retry.retry,
    attempt: retry.attempt,
    max_attempts: retry.max_attempts,
    last_error: retry.last_error,
    requested_by: state.requestedBy,
    notion_page_id: state.notionPageId,
    course_variant: state.courseVariant,
    course_summary: state.courseSummary?.text ?? null,
    course_summary_error: state.courseSummary?.error ?? null,
    course_summary_period:
      state.courseSummary?.periodFrom && state.courseSummary.periodTo
        ? { from: state.courseSummary.periodFrom, to: state.courseSummary.periodTo }
        : null,
    course_summary_race_count: state.courseSummary?.raceCount ?? null,
    course_summary_race_count_truncated: state.courseSummary?.raceCountTruncated ?? false,
    gemini: {
      course: courseGeminiJson(state.gemini?.course),
      race: raceGeminiJson(state.gemini?.race),
    },
    odds: state.odds
      ? {
          available: state.odds.available,
          kind: state.odds.kind,
          observed_at_jst: state.odds.observedAtJst,
          reason: state.odds.reason,
        }
      : null,
    ticket_count_corrections: (state.ticketCountCorrections ?? []).map((item) => ({
      tickets: item.tickets,
      declared: item.declared,
      counted: item.counted,
    })),
    race_input_gaps: state.raceInputGaps ?? null,
  });
}

async function getJobInput(url: URL, deps: HttpDeps): Promise<Response> {
  const raceKey = url.searchParams.get("race_key");
  if (!raceKey) throw new JobError("race_key を指定してください", false);
  const state = await loadJob(deps.kv, raceKey);
  if (!state) return json({ error: "ジョブがありません", race_key: raceKey }, 404);
  const include = includeParts(url);
  const stored = await loadPredictInput(deps.kv, raceKey);
  const horses = stored?.horses?.length ? stored.horses : horseFormSnapshots(state.entries ?? [], state.formTasks ?? []);
  const warnings = state.consistencyWarnings ?? [];
  const body: Record<string, unknown> = {
    race_key: state.race.raceKey,
    run_id: state.runId,
    phase: state.phase,
    checked: Array.isArray(state.consistencyWarnings),
    stored: Boolean(stored),
    truncated: Boolean(stored?.truncated),
    incomplete: Boolean(stored?.incomplete),
    umabashira_bytes: state.predictInput?.umabashiraBytes ?? null,
    race_input_bytes: state.predictInput?.raceInputBytes ?? null,
    warnings: warnings.map(warningJson),
    horses: horses.map(horseJson),
  };
  if (include.has("umabashira")) body.umabashira = stored?.umabashira ?? null;
  if (include.has("input")) body.race_input = stored?.raceInput ?? null;
  if (include.has("past_runs")) Object.assign(body, pastRunsSnapshotFields(stored));
  return json(body);
}

function courseGeminiJson(record: CourseGeminiCall | undefined): Record<string, unknown> | null {
  if (!record) return null;
  return {
    ...callJson(record),
    webSearchQueryCount:
      typeof record.webSearchQueryCount === "number" ? record.webSearchQueryCount : (record.webSearchQueries?.length ?? 0),
    webSearchQueries: Array.isArray(record.webSearchQueries) ? record.webSearchQueries : [],
  };
}

function raceGeminiJson(record: GeminiCallRecord | undefined): Record<string, unknown> | null {
  if (!record) return null;
  return callJson(record);
}

function callJson(record: GeminiCallRecord): Record<string, unknown> {
  return {
    finishReason: record.finishReason,
    modelVersion: record.modelVersion,
    usageMetadata: usageJson(record.usageMetadata),
  };
}

function usageJson(usage: GeminiUsageMetadata | undefined): GeminiUsageMetadata {
  return {
    promptTokenCount: usage?.promptTokenCount ?? null,
    candidatesTokenCount: usage?.candidatesTokenCount ?? null,
    thoughtsTokenCount: usage?.thoughtsTokenCount ?? null,
    totalTokenCount: usage?.totalTokenCount ?? null,
  };
}

function includeParts(url: URL): Set<string> {
  const raw = url.searchParams.get("include");
  if (raw == null || raw.trim() === "") return new Set(["umabashira", "input"]);
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  );
}

function warningJson(warning: ConsistencyWarning): Record<string, unknown> {
  return {
    horse_name: warning.horseName,
    kind: warning.kind,
    message: warning.message,
    race_name: warning.raceName ?? null,
    claimed: warning.claimed,
    actual: warning.actual,
    snippet: warning.snippet,
  };
}

function horseJson(horse: HorseFormSnapshot): Record<string, unknown> {
  return {
    horse_name: horse.horseName,
    horse_number: horse.horseNumber,
    resolved_name: horse.resolvedName,
    resolution_status: horse.resolutionStatus,
    past_run_count: horse.pastRunCount,
    birth_date: horse.birthDate,
    career_starts: horse.careerStarts,
    prev_official_result: horse.prevOfficialResult,
    prev_distance: horse.prevDistance,
    prev_surface: horse.prevSurface,
    days_since_last_race: horse.daysSinceLastRace,
    weight_to_carry_kg: horse.weightToCarryKg,
    past_runs: horse.pastRuns.map((run) => ({
      race_name: run.raceName,
      date: run.date,
      official_result: run.officialResult,
      surface: run.surface,
      distance: run.distance,
    })),
  };
}

async function oauthCallback(url: URL, deps: HttpDeps): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const iss = url.searchParams.get("iss");
  if (!code || !state) return html("認可コードまたは state がありません。", 400);
  try {
    await deps.oauth.completeAuthorization({ code, state, iss });
  } catch (err) {
    return html(`認可に失敗しました。${escapeHtml(errorMessage(err))}`, 400);
  }
  return html("BASHIRA の認可が完了しました。このタブを閉じて構いません。");
}

async function requireCaller(request: Request, deps: HttpDeps): Promise<Caller> {
  if (!deps.config.accessTeamDomain.startsWith("https://") || deps.config.accessTeamDomain.includes("YOUR_TEAM")) {
    throw new HttpError(500, "ACCESS_TEAM_DOMAIN を https://<team>.cloudflareaccess.com に設定してください");
  }
  if (!deps.config.accessAud || deps.config.accessAud.includes("YOUR_ACCESS_AUD")) {
    throw new HttpError(500, "ACCESS_AUD に Access アプリケーションの AUD を設定してください");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new HttpError(403, "Cf-Access-Jwt-Assertion がありません");
  let payload: JWTPayload;
  try {
    payload = await deps.verifyJwt(token);
  } catch (err) {
    throw new HttpError(403, `Access JWT を検証できません: ${errorMessage(err)}`);
  }
  return identifyCaller({
    clientId: request.headers.get("cf-access-client-id"),
    payload,
    grokClientId: deps.config.accessClientIdGrok,
    museClientId: deps.config.accessClientIdMuse,
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new JobError("JSON ボディを解釈できません", false);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function html(message: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>BASHIRA</title><p>${message}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
