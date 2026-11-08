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

/** 1 回の generateContent からジョブへ残す項目。引用本文は持たない。 */
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
  error?: { message?: string };
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
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
  const payload = (await response.json().catch(() => ({}))) as GeminiPayload;
  if (!response.ok) {
    const message = payload.error?.message ?? `HTTP ${response.status}`;
    throw new JobError(
      `Gemini (${input.model}) が失敗しました: ${message}`,
      response.status === 429 || response.status >= 500,
    );
  }
  const candidate = payload.candidates?.[0];
  const text = responseText(candidate?.content?.parts);
  if (!text.trim()) throw new JobError(`Gemini (${input.model}) の応答テキストが空です`, true);
  const modelVersion = typeof payload.modelVersion === "string" ? payload.modelVersion : null;
  return {
    text,
    modelVersion,
    requestedModel: input.model,
    finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : null,
    usageMetadata: readUsage(payload.usageMetadata),
    webSearchQueries: readWebSearchQueries(candidate),
  };
}

/** part.thought が true の思考文は連結しない。引用メタデータはここには無い。 */
function responseText(parts: GeminiPart[] | undefined): string {
  if (!parts) return "";
  let text = "";
  for (const part of parts) {
    if (part.thought === true) continue;
    if (typeof part.text === "string") text += part.text;
  }
  return text;
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
