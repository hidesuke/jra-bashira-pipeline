import { budgetedFetch, ExternalBudget } from "./budget";
import { formatJstNow } from "./jst";
import { kvGetJson, kvPutJson, keys } from "./kv";
import { DEFAULT_MODEL_NAME, JobError, MODEL_LIST_TTL_MS, type KvStore } from "./types";

export interface ModelConfig {
  course: string;
  race: string;
}

export interface ModelChange {
  at_jst: string;
  caller: string;
  client_id: string | null;
  old: ModelConfig;
  new: ModelConfig;
  restored?: boolean;
}

export interface GeminiModelInfo {
  name: string;
  displayName: string | null;
  methods: string[];
}

interface CachedModels {
  fetchedAt: number;
  models: GeminiModelInfo[];
}

export function defaultModels(fallback = DEFAULT_MODEL_NAME): ModelConfig {
  return { course: fallback, race: fallback };
}

export function normalizeModelName(name: string): string {
  return name.trim().replace(/^models\//, "");
}

export function applyModelUpdate(input: {
  current: ModelConfig;
  history: ModelChange[];
  patch: Partial<ModelConfig>;
  caller: string;
  clientId: string | null;
  now: Date;
}): { current: ModelConfig; previous: ModelConfig; history: ModelChange[] } {
  const next: ModelConfig = {
    course: input.patch.course ? normalizeModelName(input.patch.course) : input.current.course,
    race: input.patch.race ? normalizeModelName(input.patch.race) : input.current.race,
  };
  if (!input.patch.course && !input.patch.race) {
    throw new JobError("course か race のどちらかのモデル名を指定してください", false);
  }
  const change: ModelChange = {
    at_jst: formatJstNow(input.now),
    caller: input.caller,
    client_id: input.clientId,
    old: input.current,
    new: next,
  };
  return {
    current: next,
    previous: input.current,
    history: [...input.history, change].slice(-100),
  };
}

export function restoreModelUpdate(input: {
  current: ModelConfig;
  previous: ModelConfig | null;
  history: ModelChange[];
  caller: string;
  clientId: string | null;
  now: Date;
}): { current: ModelConfig; previous: ModelConfig; history: ModelChange[] } {
  if (!input.previous) {
    throw new JobError("戻せる直前のモデル設定がありません", false);
  }
  const change: ModelChange = {
    at_jst: formatJstNow(input.now),
    caller: input.caller,
    client_id: input.clientId,
    old: input.current,
    new: input.previous,
    restored: true,
  };
  return {
    current: input.previous,
    previous: input.current,
    history: [...input.history, change].slice(-100),
  };
}

export function assertModelsAllowed(config: ModelConfig, allowed: Set<string>): void {
  for (const stage of ["course", "race"] as const) {
    if (!allowed.has(config[stage])) {
      throw new JobError(
        `${stage} モデル ${config[stage]} は generateContent 対応の一覧にありません`,
        false,
      );
    }
  }
}

export async function loadModels(kv: KvStore, fallback: string): Promise<{ config: ModelConfig; source: "kv" | "default" }> {
  const stored = await kvGetJson<ModelConfig>(kv, keys.models);
  if (!stored?.course || !stored.race) return { config: defaultModels(fallback), source: "default" };
  return {
    config: { course: normalizeModelName(stored.course), race: normalizeModelName(stored.race) },
    source: "kv",
  };
}

export async function loadModelHistory(kv: KvStore): Promise<{ previous: ModelConfig | null; history: ModelChange[] }> {
  const previous = await kvGetJson<ModelConfig>(kv, keys.modelsPrevious);
  const history = (await kvGetJson<ModelChange[]>(kv, keys.modelsHistory)) ?? [];
  return { previous, history };
}

export async function saveModelState(
  kv: KvStore,
  state: { current: ModelConfig; previous: ModelConfig; history: ModelChange[] },
): Promise<void> {
  await kvPutJson(kv, keys.models, state.current);
  await kvPutJson(kv, keys.modelsPrevious, state.previous);
  await kvPutJson(kv, keys.modelsHistory, state.history);
}

export function generateContentModels(payload: unknown): GeminiModelInfo[] {
  const models = payload && typeof payload === "object" ? (payload as { models?: unknown }).models : null;
  if (!Array.isArray(models)) return [];
  const listed: GeminiModelInfo[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const record = model as { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown };
    const methods = Array.isArray(record.supportedGenerationMethods)
      ? record.supportedGenerationMethods.filter((method): method is string => typeof method === "string")
      : [];
    if (!methods.includes("generateContent") || typeof record.name !== "string") continue;
    listed.push({
      name: normalizeModelName(record.name),
      displayName: typeof record.displayName === "string" ? record.displayName : null,
      methods,
    });
  }
  return listed;
}

export async function listGenerateContentModels(input: {
  kv: KvStore;
  apiKey: string;
  budget: ExternalBudget;
  now: Date;
  force?: boolean;
  fetcher?: typeof fetch;
}): Promise<GeminiModelInfo[]> {
  if (!input.force) {
    const cached = await kvGetJson<CachedModels>(input.kv, keys.geminiModels);
    if (cached && input.now.getTime() - cached.fetchedAt < MODEL_LIST_TTL_MS) return cached.models;
  }
  const models: GeminiModelInfo[] = [];
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await budgetedFetch(
      input.budget,
      url.toString(),
      { headers: { "x-goog-api-key": input.apiKey } },
      input.fetcher,
    );
    if (!response.ok) {
      throw new JobError(`Gemini models.list に失敗しました（HTTP ${response.status}）`, response.status === 429 || response.status >= 500);
    }
    const payload = (await response.json()) as { nextPageToken?: string };
    models.push(...generateContentModels(payload));
    pageToken = payload.nextPageToken ?? "";
    if (!pageToken) break;
  }
  const unique = new Map(models.map((model) => [model.name, model]));
  const listed = [...unique.values()];
  await kvPutJson(input.kv, keys.geminiModels, { fetchedAt: input.now.getTime(), models: listed }, 10 * 60);
  return listed;
}
