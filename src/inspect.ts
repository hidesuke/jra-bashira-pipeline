import type { ConsistencyWarning } from "./consistency";
import { mergeGoing } from "./dify-input";
import type { GeminiUsageMetadata } from "./gemini";
import { loadJob, type JobState } from "./job";
import { keys } from "./kv";
import { loadLlmTrace, type LlmTrace } from "./llm-trace";
import type { OddsSummary } from "./odds";
import { loadPredictInput, type PredictInputRecord } from "./predict-input";
import { numberField, stringField } from "./rows";
import { errorMessage, JobError, type KvStore } from "./types";

const RACE_KEY_IN_LIST = /^job:v1:(\d{8}-\d{2}-\d{2})$/;
const SECRET_KEYS = new Set([
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "secret",
  "password",
  "clientsecret",
  "notiontoken",
  "geminiapikey",
  "encryptionkey",
  "privatekey",
  "accessaud",
  "credential",
  "credentials",
]);

export async function handleInspect(url: URL, kv: KvStore): Promise<Response> {
  const format = readFormat(url);
  const raceKey = readRaceKey(url);
  if (raceKey) {
    const view = await loadInspectView(kv, raceKey);
    if (!view) return json({ error: "ジョブがありません", race_key: raceKey }, 404);
    if (format === "markdown") return markdown(renderInspectMarkdown(view));
    return json(view);
  }
  const date = readDate(url);
  if (!date) throw new JobError("race_key または date を指定してください", false);
  const listed = await listJobs(kv, date);
  if (format === "markdown") return markdown(renderDayMarkdown(listed));
  return json(listed);
}

export async function loadInspectView(kv: KvStore, raceKey: string): Promise<InspectView | null> {
  const state = await loadJob(kv, raceKey);
  if (!state) return null;
  const stored = await readOptional(() => loadPredictInput(kv, raceKey));
  const trace = await readOptional(() => loadLlmTrace(kv, raceKey));
  return buildInspectView(raceKey, state, stored.value, trace.value, stored.error, trace.error);
}

export function buildInspectView(
  raceKey: string,
  state: JobState,
  stored: PredictInputRecord | null,
  trace: LlmTrace | null,
  inputError: string | null,
  traceError: string | null,
): InspectView {
  const raceRow = asRecord(sanitize(state.raceRow));
  const baba = sanitize(state.baba);
  const surface = raceRow ? stringField(raceRow, "surface") : null;
  const going = mergeGoing({ raceRow, baba, surface });
  const summary = readCourseSummary(state);
  const prediction = state.prediction;
  const courseCall = state.gemini?.course;
  const raceCall = state.gemini?.race;
  const raceQueries = trace?.raceWebSearchQueries ?? null;
  return {
    note: "システムプロンプト、トークン、API キーは返しません。出力は Notion に書く前の全文です。",
    race_key: state.race?.raceKey || raceKey,
    run_id: state.runId ?? null,
    phase: state.phase ?? null,
    error: state.error ?? null,
    requested_by: state.requestedBy ?? null,
    updated_at: state.updatedAt ?? null,
    notion_page_id: state.notionPageId ?? null,
    truncated: Boolean(stored?.truncated) || Boolean(trace?.truncated),
    incomplete: Boolean(stored?.incomplete) || Boolean(trace?.incomplete),
    input_error: inputError,
    trace_error: traceError,
    race: {
      date: state.race?.date ?? null,
      venue: state.race?.venue ?? null,
      venue_code: state.race?.venueCode ?? null,
      race_number: state.race?.raceNumber ?? null,
      race_name: raceRow ? stringField(raceRow, "race_name_main") : null,
      grade: raceRow ? stringField(raceRow, "grade") : null,
      surface,
      distance: raceRow ? numberField(raceRow, "distance") : null,
      weather: raceRow ? stringField(raceRow, "weather") : null,
      track_condition: raceRow ? stringField(raceRow, "track_condition") : null,
    },
    going: {
      weather: going.weather,
      condition: going.condition,
      baba_detail: going.babaDetail || null,
    },
    baba,
    race_row: raceRow,
    remarks: state.remarks ?? "",
    odds: oddsView(state.odds),
    umabashira: stored?.umabashira ?? null,
    course: {
      prompt_version: trace?.coursePromptVersion ?? prediction?.coursePromptVersion ?? null,
      model: trace?.courseModel ?? prediction?.courseModel ?? null,
      user_text: trace?.courseUser ?? null,
      output_text: trace?.courseOutput ?? prediction?.courseText ?? null,
      finishReason: courseCall?.finishReason ?? null,
      modelVersion: courseCall?.modelVersion ?? prediction?.courseModelVersion ?? null,
      usageMetadata: courseCall ? usageView(courseCall.usageMetadata) : null,
      webSearchQueryCount: courseCall
        ? typeof courseCall.webSearchQueryCount === "number"
          ? courseCall.webSearchQueryCount
          : (courseCall.webSearchQueries?.length ?? 0)
        : null,
      webSearchQueries: courseCall
        ? (courseCall.webSearchQueries ?? []).filter((query) => typeof query === "string")
        : null,
    },
    race_prediction: {
      prompt_version: trace?.racePromptVersion ?? prediction?.racePromptVersion ?? null,
      model: trace?.raceModel ?? prediction?.raceModel ?? null,
      user_text: stored?.raceInput ?? null,
      output_text: trace?.raceOutput ?? prediction?.予想本文 ?? null,
      予想本文: prediction?.予想本文 ?? null,
      指数分布: prediction?.指数分布 ?? null,
      自信度: prediction?.自信度 ?? null,
      波乱度: prediction?.波乱度 ?? null,
      印: prediction?.印 ?? null,
      finishReason: raceCall?.finishReason ?? null,
      modelVersion: raceCall?.modelVersion ?? prediction?.raceModelVersion ?? null,
      usageMetadata: raceCall ? usageView(raceCall.usageMetadata) : null,
      webSearchQueryCount: raceQueries ? raceQueries.length : null,
      webSearchQueries: raceQueries,
    },
    course_summary: summary.text,
    course_summary_error: summary.error,
    warnings: (state.consistencyWarnings ?? []).map(warningView),
  };
}

export function renderInspectMarkdown(view: InspectView): string {
  const race = view.race;
  const parts = [
    `# レース ${view.race_key}`,
    "",
    view.note,
    "",
    "## レース情報",
    "",
    [
      bullet("race_key", view.race_key),
      bullet("run_id", view.run_id),
      bullet("phase", view.phase),
      bullet("requested_by", view.requested_by),
      bullet("updated_at", view.updated_at),
      bullet("notion_page_id", view.notion_page_id),
      bullet("日付", race.date),
      bullet("競馬場", race.venue),
      bullet("場コード", race.venue_code),
      bullet("レース番号", race.race_number),
      bullet("レース名", race.race_name),
      bullet("グレード", race.grade),
      bullet("馬場種類", race.surface),
      bullet("距離", race.distance),
      bullet("天気（レース）", race.weather),
      bullet("馬場状態（レース）", race.track_condition),
      bullet("truncated", view.truncated),
      bullet("incomplete", view.incomplete),
    ].join("\n"),
    "",
    "## エラー",
    "",
    view.error ? fence(view.error) : "（なし）",
    "",
    missingNote("入力の読み取り", view.input_error),
    missingNote("呼び出し記録の読み取り", view.trace_error),
    "## 馬場",
    "",
    [
      bullet("天気", view.going.weather),
      bullet("馬場状態", view.going.condition),
      bullet("馬場の詳細", view.going.baba_detail),
    ].join("\n"),
    "",
    "### 馬場 API の保存値",
    "",
    view.baba == null ? "（保存されていません）" : fence(JSON.stringify(view.baba, null, 2)),
    "",
    "## オッズ",
    "",
    oddsMarkdown(view.odds),
    "",
    "## 馬柱",
    "",
    textBlock(view.umabashira),
    "",
    "## コース分析",
    "",
    "### プロンプト版",
    "",
    textBlock(view.course.prompt_version),
    "",
    "### ユーザー文",
    "",
    textBlock(view.course.user_text),
    "",
    "### 出力",
    "",
    textBlock(view.course.output_text),
    "",
    "### 呼び出し結果",
    "",
    callMarkdown(view.course),
    "",
    "## レース予想",
    "",
    "### プロンプト版",
    "",
    textBlock(view.race_prediction.prompt_version),
    "",
    "### ユーザー文",
    "",
    textBlock(view.race_prediction.user_text),
    "",
    "### 出力",
    "",
    textBlock(view.race_prediction.output_text),
    "",
    "### 予想本文",
    "",
    textBlock(view.race_prediction.予想本文),
    "",
    [
      bullet("指数分布", view.race_prediction.指数分布),
      bullet("自信度", view.race_prediction.自信度),
      bullet("波乱度", view.race_prediction.波乱度),
      bullet("印", view.race_prediction.印),
    ].join("\n"),
    "",
    "### 呼び出し結果",
    "",
    callMarkdown(view.race_prediction),
    "",
    "## コースデータ要約",
    "",
    "### 本文",
    "",
    textBlock(view.course_summary),
    "",
    "### エラー",
    "",
    view.course_summary_error ? fence(view.course_summary_error) : "（なし）",
    "",
    "## その他の入力",
    "",
    "### 備考",
    "",
    view.remarks ? fence(view.remarks) : "（なし）",
    "",
    "### レース行",
    "",
    view.race_row == null ? "（保存されていません）" : fence(JSON.stringify(view.race_row, null, 2)),
    "",
    "### 整合性の警告",
    "",
    view.warnings.length === 0 ? "（なし）" : fence(JSON.stringify(view.warnings, null, 2)),
    "",
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function listJobs(kv: KvStore, compactDate: string): Promise<DayView> {
  if (typeof kv.list !== "function") throw new JobError("この KV は日付の一覧に対応していません", false);
  const names: string[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const prefix = `job:v1:${compactDate}`;
  for (;;) {
    const page = await kv.list({ prefix, limit: 1000, cursor });
    for (const key of page.keys) names.push(key.name);
    if (page.list_complete || !page.cursor || seenCursors.has(page.cursor)) break;
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  const jobs: DayJob[] = [];
  for (const name of names.sort()) {
    const matched = RACE_KEY_IN_LIST.exec(name);
    if (!matched) continue;
    const raceKey = matched[1]!;
    jobs.push(await dayJob(kv, raceKey));
  }
  return { date: displayDate(compactDate), jobs };
}

export function renderDayMarkdown(day: DayView): string {
  const lines = [`# ${day.date} のジョブ`, ""];
  if (day.jobs.length === 0) {
    lines.push("この日のジョブはありません。");
    return lines.join("\n");
  }
  for (const job of day.jobs) {
    const error = job.error ? ` error=${job.error}` : "";
    lines.push(
      `- \`${job.race_key}\` phase=${job.phase ?? "不明"} run_id=${job.run_id ?? "なし"} requested_by=${job.requested_by ?? "なし"} has_prediction=${job.has_prediction}${error}`,
    );
  }
  return lines.join("\n");
}

async function dayJob(kv: KvStore, raceKey: string): Promise<DayJob> {
  try {
    const raw = await kv.get(keys.job(raceKey));
    if (raw == null || raw === "") {
      return { race_key: raceKey, phase: null, error: "ジョブを読めません", run_id: null, requested_by: null, updated_at: null, has_prediction: false };
    }
    const state = JSON.parse(raw) as JobState;
    return {
      race_key: raceKey,
      phase: state.phase ?? null,
      error: state.error ?? null,
      run_id: state.runId ?? null,
      requested_by: state.requestedBy ?? null,
      updated_at: state.updatedAt ?? null,
      has_prediction: state.prediction != null,
    };
  } catch (err) {
    const message = err instanceof SyntaxError ? `KV の ${keys.job(raceKey)} を JSON として読めません` : errorMessage(err);
    return { race_key: raceKey, phase: null, error: message, run_id: null, requested_by: null, updated_at: null, has_prediction: false };
  }
}

function readFormat(url: URL): "json" | "markdown" {
  const format = (url.searchParams.get("format") ?? "json").trim();
  if (format === "json" || format === "markdown") return format;
  throw new JobError("format は json または markdown です", false);
}

function readRaceKey(url: URL): string | null {
  const value = url.searchParams.get("race_key") ?? url.searchParams.get("raceKey");
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function readDate(url: URL): string | null {
  const raw = url.searchParams.get("date");
  if (raw == null || raw.trim() === "") return null;
  const compact = raw.trim();
  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(compact);
  if (dashed) return `${dashed[1]}${dashed[2]}${dashed[3]}`;
  if (/^\d{8}$/.test(compact)) return compact;
  throw new JobError("date は YYYY-MM-DD または YYYYMMDD です", false);
}

function displayDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

async function readOptional<T>(load: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await load(), error: null };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
  }
}

function readCourseSummary(state: JobState): { text: string | null; error: string | null } {
  const extra = state as JobState & {
    courseSummary?: { text?: unknown; error?: unknown } | null;
    course_summary?: unknown;
    course_summary_error?: unknown;
  };
  if (extra.courseSummary && typeof extra.courseSummary === "object") {
    return { text: textOrNull(extra.courseSummary.text), error: textOrNull(extra.courseSummary.error) };
  }
  if ("course_summary" in extra || "course_summary_error" in extra) {
    return { text: textOrNull(extra.course_summary), error: textOrNull(extra.course_summary_error) };
  }
  return { text: null, error: null };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function usageView(usage: GeminiUsageMetadata | undefined): GeminiUsageMetadata {
  return {
    promptTokenCount: usage?.promptTokenCount ?? null,
    candidatesTokenCount: usage?.candidatesTokenCount ?? null,
    thoughtsTokenCount: usage?.thoughtsTokenCount ?? null,
    totalTokenCount: usage?.totalTokenCount ?? null,
  };
}

function oddsView(odds: OddsSummary | null): InspectOdds | null {
  if (!odds) return null;
  const clean = sanitize(odds) as OddsSummary;
  return {
    available: Boolean(clean.available),
    kind: clean.kind ?? null,
    observed_at_jst: clean.observedAtJst ?? null,
    reason: clean.reason ?? null,
    detail: clean.detail ?? null,
    source: clean.source ?? null,
    horses: (clean.horses ?? []).map((horse) => ({
      horse_number: horse.horseNumber ?? null,
      selection: horse.selection ?? null,
      odds: horse.odds ?? null,
      odds_min: horse.oddsMin ?? null,
      odds_max: horse.oddsMax ?? null,
      status: horse.status ?? null,
      kind: horse.kind ?? null,
      observed_at_jst: horse.observedAtJst ?? null,
    })),
  };
}

function warningView(warning: ConsistencyWarning): Record<string, unknown> {
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

function callMarkdown(call: InspectCall): string {
  if (
    call.model == null &&
    call.finishReason == null &&
    call.modelVersion == null &&
    call.usageMetadata == null &&
    call.webSearchQueryCount == null &&
    call.webSearchQueries == null
  ) {
    return "（この呼び出しは保存されていません）";
  }
  const usage = call.usageMetadata;
  const lines = [
    bullet("model", call.model),
    bullet("finishReason", call.finishReason),
    bullet("modelVersion", call.modelVersion),
    bullet("promptTokenCount", usage?.promptTokenCount ?? null),
    bullet("candidatesTokenCount", usage?.candidatesTokenCount ?? null),
    bullet("thoughtsTokenCount", usage?.thoughtsTokenCount ?? null),
    bullet("totalTokenCount", usage?.totalTokenCount ?? null),
    bullet("webSearchQueryCount", call.webSearchQueryCount),
  ];
  if (call.webSearchQueries == null) lines.push("- webSearchQueries: （保存されていません）");
  else if (call.webSearchQueries.length === 0) lines.push("- webSearchQueries: （なし）");
  else {
    lines.push("- webSearchQueries:");
    for (const query of call.webSearchQueries) lines.push(`  - ${query}`);
  }
  return lines.join("\n");
}

function oddsMarkdown(odds: InspectOdds | null): string {
  if (!odds) return "（保存されていません）";
  const lines = [
    bullet("available", odds.available),
    bullet("kind", odds.kind),
    bullet("observed_at_jst", odds.observed_at_jst),
    bullet("reason", odds.reason),
    bullet("detail", odds.detail),
    bullet("source", odds.source),
    "",
    fence(JSON.stringify(odds.horses, null, 2)),
  ];
  return lines.join("\n");
}

function missingNote(label: string, error: string | null): string {
  if (!error) return "";
  return `${label}: ${error}\n\n`;
}

function bullet(label: string, value: unknown): string {
  if (value == null || value === "") return `- ${label}: （なし）`;
  return `- ${label}: ${String(value)}`;
}

function textBlock(value: string | null): string {
  if (value == null) return "（保存されていません）";
  if (value === "") return "（空）";
  return fence(value);
}

function fence(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const tick = "`".repeat(Math.max(3, longest + 1));
  return `${tick}\n${text}\n${tick}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** キー名が秘密情報のものは落とす。本文中の文字列は変えない。 */
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase().replaceAll(/[-_]/g, ""))) continue;
    out[key] = sanitize(item);
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function markdown(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
}

interface InspectCall {
  model: string | null;
  finishReason: string | null;
  modelVersion: string | null;
  usageMetadata: GeminiUsageMetadata | null;
  webSearchQueryCount: number | null;
  webSearchQueries: string[] | null;
}

interface InspectOdds {
  available: boolean;
  kind: string | null;
  observed_at_jst: string | null;
  reason: string | null;
  detail: string | null;
  source: string | null;
  horses: Array<{
    horse_number: number | null;
    selection: string | null;
    odds: number | null;
    odds_min: number | null;
    odds_max: number | null;
    status: string | null;
    kind: string | null;
    observed_at_jst: string | null;
  }>;
}

export interface InspectView {
  note: string;
  race_key: string;
  run_id: string | null;
  phase: string | null;
  error: string | null;
  requested_by: string | null;
  updated_at: string | null;
  notion_page_id: string | null;
  truncated: boolean;
  incomplete: boolean;
  input_error: string | null;
  trace_error: string | null;
  race: {
    date: string | null;
    venue: string | null;
    venue_code: string | null;
    race_number: number | null;
    race_name: string | null;
    grade: string | null;
    surface: string | null;
    distance: number | null;
    weather: string | null;
    track_condition: string | null;
  };
  going: { weather: string; condition: string; baba_detail: string | null };
  baba: unknown;
  race_row: Record<string, unknown> | null;
  remarks: string;
  odds: InspectOdds | null;
  umabashira: string | null;
  course: InspectCall & { prompt_version: string | null; user_text: string | null; output_text: string | null };
  race_prediction: InspectCall & {
    prompt_version: string | null;
    user_text: string | null;
    output_text: string | null;
    予想本文: string | null;
    指数分布: string | null;
    自信度: string | null;
    波乱度: string | null;
    印: string | null;
  };
  course_summary: string | null;
  course_summary_error: string | null;
  warnings: Array<Record<string, unknown>>;
}

interface DayJob {
  race_key: string;
  phase: string | null;
  error: string | null;
  run_id: string | null;
  requested_by: string | null;
  updated_at: string | null;
  has_prediction: boolean;
}

interface DayView {
  date: string;
  jobs: DayJob[];
}
