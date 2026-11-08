import { budgetedFetch, ExternalBudget } from "./budget";
import { JobError } from "./types";

const RACE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    指数分布: { type: "string" },
    自信度: { type: "string" },
    波乱度: { type: "string" },
    印: { type: "string" },
    予想本文: { type: "string" },
  },
  required: ["指数分布", "自信度", "波乱度", "印", "予想本文"],
};

/** ジョブに残すトークン数。無い項目は null。思考トークンは thoughtsTokenCount。 */
export interface GeminiUsageMetadata {
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  thoughtsTokenCount: number | null;
  totalTokenCount: number | null;
}

/** 1 回の streamGenerateContent からジョブへ残す項目。引用本文は持たない。 */
export interface GeminiCallRecord {
  finishReason: string | null;
  modelVersion: string | null;
  usageMetadata: GeminiUsageMetadata;
}

/** コース分析だけ。groundingMetadata.webSearchQueries の件数と文字列。 */
export interface CourseGeminiCall extends GeminiCallRecord {
  webSearchQueryCount: number;
  webSearchQueries: string[];
}

export interface GoogleSearchTool {
  googleSearch: Record<string, never>;
}

export interface GeminiText {
  text: string;
  modelVersion: string | null;
  requestedModel: string;
  finishReason: string | null;
  usageMetadata: GeminiUsageMetadata;
  /** 応答の webSearchQueries。レース予想ではジョブに残さない。本文には混ぜない。 */
  webSearchQueries: string[];
  /** 渡した user メッセージ。system は含めない。 */
  userText: string;
}

interface GenerateTextInput {
  apiKey: string;
  model: string;
  /** Gemini の systemInstruction。Dify の system メッセージ。 */
  system?: string;
  /** Gemini の user メッセージ。 */
  prompt: string;
  budget: ExternalBudget;
  json?: boolean;
  /** コース分析だけ渡す。レース予想は省略する。 */
  tools?: GoogleSearchTool[];
  fetcher?: typeof fetch;
}

interface GeminiPart {
  text?: unknown;
  thought?: unknown;
}

interface GeminiCandidate {
  finishReason?: unknown;
  content?: { parts?: GeminiPart[] };
  groundingMetadata?: { webSearchQueries?: unknown };
}

interface GeminiPayload {
  modelVersion?: unknown;
  error?: { message?: unknown; code?: unknown };
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
  candidates?: GeminiCandidate[];
}

export async function generateText(input: GenerateTextInput): Promise<GeminiText> {
  assertModelId(input.model);
  try {
    return await callGemini(input, Boolean(input.json));
  } catch (err) {
    if (!input.json || !(err instanceof JobError) || err.retryable) throw err;
    return callGemini(input, false);
  }
}

export function courseCallRecord(result: GeminiText): CourseGeminiCall {
  return {
    finishReason: result.finishReason,
    modelVersion: result.modelVersion,
    usageMetadata: result.usageMetadata,
    webSearchQueryCount: result.webSearchQueries.length,
    webSearchQueries: result.webSearchQueries,
  };
}

export function raceCallRecord(result: GeminiText): GeminiCallRecord {
  return {
    finishReason: result.finishReason,
    modelVersion: result.modelVersion,
    usageMetadata: result.usageMetadata,
  };
}

async function callGemini(input: GenerateTextInput, json: boolean): Promise<GeminiText> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`;
  const generationConfig: Record<string, unknown> = {
    thinkingConfig: { thinkingLevel: "high" },
  };
  if (json) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = RACE_RESPONSE_SCHEMA;
  }
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
    generationConfig,
  };
  if (input.system?.trim()) {
    body.systemInstruction = { parts: [{ text: input.system }] };
  }
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
  }
  const response = await budgetedFetch(
    input.budget,
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey,
      },
      body: JSON.stringify(body),
    },
    input.fetcher,
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as GeminiPayload;
    const message = typeof payload.error?.message === "string" ? payload.error.message : `HTTP ${response.status}`;
    throw new JobError(
      `Gemini (${input.model}) が失敗しました: ${message}`,
      response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  const streamed = await readGeminiSse(response, input.model);
  const text = streamed.texts.join("");
  if (!text.trim()) throw new JobError(`Gemini (${input.model}) の応答テキストが空です`, true);
  return {
    text,
    modelVersion: streamed.modelVersion,
    requestedModel: input.model,
    finishReason: streamed.finishReason,
    usageMetadata: readUsage(streamed.usageMetadata),
    webSearchQueries: streamed.webSearchQueries,
    userText: input.prompt,
  };
}

interface StreamedGemini {
  texts: string[];
  modelVersion: string | null;
  finishReason: string | null;
  usageMetadata: GeminiPayload["usageMetadata"];
  webSearchQueries: string[];
}

/**
 * 届いたチャンクだけを見る。区切りの前の生テキストは連結せず、イベントが閉じたら捨てる。
 * 待ち時間はここには含まれない。CPU はイベントごとの JSON.parse だけ増える。
 */
async function readGeminiSse(response: Response, model: string): Promise<StreamedGemini> {
  const body = response.body;
  if (!body) throw new JobError(`Gemini (${model}) のストリームが途中で切れました`, true);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseEventParser();
  const streamed: StreamedGemini = {
    texts: [],
    modelVersion: null,
    finishReason: null,
    usageMetadata: undefined,
    webSearchQueries: [],
  };
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      for (const event of parser.push(decoder.decode(step.value, { stream: true }))) {
        applyGeminiEvent(streamed, event, model);
      }
    }
    const flushed = decoder.decode();
    if (flushed) {
      for (const event of parser.push(flushed)) applyGeminiEvent(streamed, event, model);
    }
    for (const event of parser.finish()) applyGeminiEvent(streamed, event, model);
  } catch (err) {
    if (err instanceof JobError) throw err;
    if (err instanceof SseParseError) throw sseFailure(model, err.kind);
    const message = err instanceof Error ? err.message : String(err);
    throw new JobError(
      message ? `Gemini (${model}) のストリームが途中で切れました: ${message}` : `Gemini (${model}) のストリームが途中で切れました`,
      true,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return streamed;
}

function applyGeminiEvent(streamed: StreamedGemini, payload: GeminiPayload, model: string): void {
  if (payload.error && typeof payload.error === "object") {
    const code =
      typeof payload.error.code === "number" && Number.isInteger(payload.error.code) ? payload.error.code : null;
    const message =
      typeof payload.error.message === "string" && payload.error.message.trim() !== ""
        ? payload.error.message
        : code != null
          ? `HTTP ${code}`
          : "ストリームがエラーを返しました";
    throw new JobError(
      `Gemini (${model}) が失敗しました: ${message}`,
      code == null || code === 429 || code >= 500,
      code,
    );
  }
  if (typeof payload.modelVersion === "string") streamed.modelVersion = payload.modelVersion;
  if (payload.usageMetadata && typeof payload.usageMetadata === "object") {
    streamed.usageMetadata = payload.usageMetadata;
  }
  const candidate = payload.candidates?.[0];
  if (!candidate) return;
  if (typeof candidate.finishReason === "string") streamed.finishReason = candidate.finishReason;
  if (Array.isArray(candidate.groundingMetadata?.webSearchQueries)) {
    streamed.webSearchQueries = readWebSearchQueries(candidate);
  }
  const parts = candidate.content?.parts;
  if (!parts) return;
  for (const part of parts) {
    if (part.thought === true) continue;
    if (typeof part.text === "string" && part.text.length > 0) streamed.texts.push(part.text);
  }
}

function sseFailure(model: string, kind: "truncated" | "invalid"): JobError {
  const detail = kind === "truncated" ? "ストリームが途中で切れました" : "ストリームを解釈できません";
  return new JobError(`Gemini (${model}) の${detail}`, true);
}

function readUsage(raw: GeminiPayload["usageMetadata"]): GeminiUsageMetadata {
  return {
    promptTokenCount: tokenCount(raw?.promptTokenCount),
    candidatesTokenCount: tokenCount(raw?.candidatesTokenCount),
    thoughtsTokenCount: tokenCount(raw?.thoughtsTokenCount),
    totalTokenCount: tokenCount(raw?.totalTokenCount),
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readWebSearchQueries(candidate: GeminiCandidate | undefined): string[] {
  const raw = candidate?.groundingMetadata?.webSearchQueries;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

class SseParseError extends Error {
  constructor(readonly kind: "truncated" | "invalid") {
    super(kind);
  }
}

/**
 * SSE を増分で読む。閉じたイベントは捨て、未完の末尾だけを持つ。
 * 区切りが来るまで全体を連結し直さない。
 */
class SseEventParser {
  private parts: string[] = [];
  /** 未完バッファの末尾 2 文字。チャンクをまたぐ空行の判定にだけ使う。 */
  private tailEnd = "";

  push(chunk: string): GeminiPayload[] {
    if (chunk.length === 0) return [];
    const seam = this.tailEnd + (chunk.length > 3 ? chunk.slice(0, 3) : chunk);
    const hit = findSseBoundary(chunk, 0) !== null || findSseBoundary(seam, 0) !== null;
    this.parts.push(chunk);
    if (!hit) {
      this.tailEnd = tailEnd(this.tailEnd, chunk);
      return [];
    }
    return this.drain(false);
  }

  finish(): GeminiPayload[] {
    if (this.parts.length === 0) return [];
    return this.drain(true);
  }

  private drain(ended: boolean): GeminiPayload[] {
    const data = this.parts.length === 1 ? this.parts[0]! : this.parts.join("");
    this.parts = [];
    const events: GeminiPayload[] = [];
    let cursor = 0;
    while (cursor < data.length) {
      const boundary = findSseBoundary(data, cursor);
      if (!boundary) break;
      const parsed = parseSseBlock(data.slice(cursor, boundary.index), true);
      if (parsed) events.push(parsed);
      cursor = boundary.index + boundary.length;
    }
    const rest = cursor === 0 ? data : cursor >= data.length ? "" : data.slice(cursor);
    if (!ended) {
      if (rest.length > 0) {
        this.parts.push(rest);
        this.tailEnd = rest.length >= 2 ? rest.slice(-2) : rest;
      } else {
        this.tailEnd = "";
      }
      return events;
    }
    this.tailEnd = "";
    if (rest.length === 0 || isBlank(rest)) return events;
    const parsed = parseSseBlock(rest, false);
    if (parsed) events.push(parsed);
    else if (!rest.endsWith("\n")) throw new SseParseError("truncated");
    return events;
  }
}

function tailEnd(prev: string, chunk: string): string {
  if (chunk.length >= 2) return chunk.slice(-2);
  return (prev + chunk).slice(-2);
}

function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 32) return false;
  }
  return true;
}

/** 空行の開始位置。LF と CRLF の混在を認める。無ければ null。 */
function findSseBoundary(data: string, from: number): { index: number; length: number } | null {
  for (let nl = data.indexOf("\n", from); nl >= 0; nl = data.indexOf("\n", nl + 1)) {
    let next = nl + 1;
    if (next < data.length && data[next] === "\r") next += 1;
    if (next < data.length && data[next] === "\n") {
      const index = nl > from && data[nl - 1] === "\r" ? nl - 1 : nl;
      return { index, length: next + 1 - index };
    }
    if (next >= data.length) return null;
  }
  return null;
}

function parseSseBlock(block: string, framed: boolean): GeminiPayload | null {
  let data: string | undefined;
  let combined: string[] | undefined;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
    if (data === undefined) data = value;
    else {
      if (!combined) combined = [data];
      combined.push(value);
    }
  }
  if (data === undefined) return null;
  return parseSseData(combined ? combined.join("\n") : data, framed);
}

function parseSseData(data: string, framed: boolean): GeminiPayload | null {
  let start = 0;
  let end = data.length;
  while (start < end && data.charCodeAt(start) <= 32) start += 1;
  while (end > start && data.charCodeAt(end - 1) <= 32) end -= 1;
  if (start === end) return null;
  if (end - start === 6 && data.startsWith("[DONE]", start)) return null;
  const json = start === 0 && end === data.length ? data : data.slice(start, end);
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SseParseError(framed ? "invalid" : "truncated");
    }
    return value as GeminiPayload;
  } catch (err) {
    if (err instanceof SseParseError) throw err;
    throw new SseParseError(framed ? "invalid" : "truncated");
  }
}

export interface RacePredictionFields {
  指数分布: string;
  自信度: string;
  波乱度: string;
  印: string;
  予想本文: string;
}

export function parseRacePrediction(text: string): RacePredictionFields {
  const parsed = parseJsonObject(text);
  const required = ["指数分布", "自信度", "波乱度", "印", "予想本文"] as const;
  const result = {} as RacePredictionFields;
  for (const key of required) {
    const value = parsed[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new JobError(`レース予想 JSON に ${key} がありません`, true);
    }
    result[key] = value.trim();
  }
  return result;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // 次の候補を試す
    }
  }
  throw new JobError("レース予想の JSON を解釈できません", true);
}

function assertModelId(model: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new JobError(`モデル名が不正です: ${model}`, false);
  }
}
