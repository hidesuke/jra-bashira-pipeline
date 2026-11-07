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

export interface GeminiText {
  text: string;
  modelVersion: string | null;
  requestedModel: string;
}

export async function generateText(input: {
  apiKey: string;
  model: string;
  /** Gemini の systemInstruction。Dify の system メッセージ。 */
  system?: string;
  /** Gemini の user メッセージ。 */
  prompt: string;
  budget: ExternalBudget;
  json?: boolean;
  fetcher?: typeof fetch;
}): Promise<GeminiText> {
  assertModelId(input.model);
  try {
    return await callGemini(input, Boolean(input.json));
  } catch (err) {
    if (!input.json || !(err instanceof JobError) || err.retryable) throw err;
    return callGemini(input, false);
  }
}

async function callGemini(
  input: { apiKey: string; model: string; system?: string; prompt: string; budget: ExternalBudget; fetcher?: typeof fetch },
  json: boolean,
): Promise<GeminiText> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
  };
  if (input.system?.trim()) {
    body.systemInstruction = { parts: [{ text: input.system }] };
  }
  if (json) {
    body.generationConfig = {
      responseMimeType: "application/json",
      responseSchema: RACE_RESPONSE_SCHEMA,
    };
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
  const payload = (await response.json().catch(() => ({}))) as {
    modelVersion?: unknown;
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  if (!response.ok) {
    const message = payload.error?.message ?? `HTTP ${response.status}`;
    throw new JobError(
      `Gemini (${input.model}) が失敗しました: ${message}`,
      response.status === 429 || response.status >= 500,
    );
  }
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!text.trim()) throw new JobError(`Gemini (${input.model}) の応答テキストが空です`, true);
  return {
    text,
    modelVersion: typeof payload.modelVersion === "string" ? payload.modelVersion : null,
    requestedModel: input.model,
  };
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
