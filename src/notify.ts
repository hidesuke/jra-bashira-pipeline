import { budgetedNotifyFetch, type ExternalBudget } from "./budget";
import { formatJstNow } from "./jst";

/** 通知の POST を待つ上限。超えたら握って捨てる。 */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** Webhook 本文の error はここまで。ジョブに残す理由は切らない。 */
export const NOTIFY_ERROR_MAX_CHARS = 240;

export interface NotifyConfig {
  /** 未設定または空白なら通知しない。 */
  url?: string;
  /** 未設定なら認証ヘッダーを付けない。 */
  key?: string;
  /**
   * 平文のヘッダー名。未設定なら Authorization。
   * Authorization のときは値を `Bearer <key>` にする。それ以外は key をそのまま入れる。
   */
  keyHeader?: string;
}

export interface RaceFailedInput {
  raceKey: string;
  runId: string;
  phaseAtFailure: string;
  error: string;
  attempts: number;
  httpStatus: number | null;
  occurredAt: Date;
}

export interface RaceFailedPayload {
  type: "race_failed";
  race_key: string;
  run_id: string;
  phase_at_failure: string;
  error: string;
  attempts: number;
  http_status?: number;
  inspect_path: string;
  jobs_path: string;
  occurred_at_jst: string;
}

export function shortError(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= NOTIFY_ERROR_MAX_CHARS) return flat;
  return `${flat.slice(0, NOTIFY_ERROR_MAX_CHARS - 3)}...`;
}

export function buildRaceFailedPayload(input: RaceFailedInput): RaceFailedPayload {
  const payload: RaceFailedPayload = {
    type: "race_failed",
    race_key: input.raceKey,
    run_id: input.runId,
    phase_at_failure: input.phaseAtFailure,
    error: shortError(input.error),
    attempts: input.attempts,
    inspect_path: `/admin/inspect?race_key=${encodeURIComponent(input.raceKey)}`,
    jobs_path: `/admin/jobs?race_key=${encodeURIComponent(input.raceKey)}`,
    occurred_at_jst: formatJstNow(input.occurredAt),
  };
  if (input.httpStatus != null) payload.http_status = input.httpStatus;
  return payload;
}

export interface BatchFailedInput {
  date: string;
  source: "cron" | "admin";
  error: string;
  limitSent: number;
  limitMaximum: number | null;
  occurredAt: Date;
}

export interface BatchFailedPayload {
  type: "batch_failed";
  date: string;
  source: "cron" | "admin";
  error: string;
  limit_sent: number;
  limit_maximum: number | null;
  occurred_at_jst: string;
}

export function buildBatchFailedPayload(input: BatchFailedInput): BatchFailedPayload {
  return {
    type: "batch_failed",
    date: input.date,
    source: input.source,
    error: shortError(input.error),
    limit_sent: input.limitSent,
    limit_maximum: input.limitMaximum,
    occurred_at_jst: formatJstNow(input.occurredAt),
  };
}

/** キーが無ければ認証ヘッダーは付けない。content-type は常に JSON。 */
export function webhookHeaders(config: NotifyConfig): Headers {
  const headers = new Headers();
  const key = config.key?.trim() ?? "";
  if (key) {
    const name = config.keyHeader?.trim() || "Authorization";
    const value = name.toLowerCase() === "authorization" ? `Bearer ${key}` : key;
    if (name.toLowerCase() !== "content-type" && name.toLowerCase() !== "content-length") {
      headers.set(name, value);
    }
  }
  headers.set("content-type", "application/json");
  return headers;
}

export function notifyConfigFromEnv(env: {
  NOTIFY_WEBHOOK_URL?: string;
  NOTIFY_WEBHOOK_KEY?: string;
  NOTIFY_WEBHOOK_KEY_HEADER?: string;
}): NotifyConfig {
  return {
    url: env.NOTIFY_WEBHOOK_URL,
    key: env.NOTIFY_WEBHOOK_KEY,
    keyHeader: env.NOTIFY_WEBHOOK_KEY_HEADER,
  };
}

/**
 * 最終失敗の通知。URL が無ければ何もしない。
 * 失敗しても投げない。ログにはステータスだけを出し、URL とキーは出さない。
 */
export async function notifyRaceFailed(
  config: NotifyConfig | undefined,
  input: RaceFailedInput,
  options: {
    budget: ExternalBudget;
    fetch?: typeof fetch;
    log?: (event: string, fields?: Record<string, unknown>) => void;
  },
): Promise<void> {
  const url = config?.url?.trim() ?? "";
  if (!url) return;
  const fetcher = options.fetch ?? fetch;
  let payloadType = "race_failed";
  try {
    const payload = buildRaceFailedPayload(input);
    payloadType = payload.type;
    const response = await budgetedNotifyFetch(
      options.budget,
      url,
      {
        method: "POST",
        headers: webhookHeaders(config ?? {}),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      },
      fetcher,
    );
    if (!response) {
      options.log?.("notify_failed", { type: payload.type, status: null });
      return;
    }
    try {
      await response.body?.cancel();
    } catch {
      // 本文は読まない。失敗しても通知結果はステータスだけで足りる。
    }
    options.log?.(response.ok ? "notify_sent" : "notify_failed", {
      type: payload.type,
      status: response.status,
    });
  } catch {
    options.log?.("notify_failed", { type: payloadType, status: null });
  }
}

/**
 * 開催日バッチが get_races の limit 上限で失敗した通知。
 * URL が無ければ何もしない。失敗しても投げない。URL とキーはログに出さない。
 */
export async function notifyBatchFailed(
  config: NotifyConfig | undefined,
  input: BatchFailedInput,
  options: {
    budget: ExternalBudget;
    fetch?: typeof fetch;
    log?: (event: string, fields?: Record<string, unknown>) => void;
  },
): Promise<void> {
  const url = config?.url?.trim() ?? "";
  if (!url) return;
  const fetcher = options.fetch ?? fetch;
  let payloadType = "batch_failed";
  try {
    const payload = buildBatchFailedPayload(input);
    payloadType = payload.type;
    const response = await budgetedNotifyFetch(
      options.budget,
      url,
      {
        method: "POST",
        headers: webhookHeaders(config ?? {}),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      },
      fetcher,
    );
    if (!response) {
      options.log?.("notify_failed", { type: payload.type, status: null });
      return;
    }
    try {
      await response.body?.cancel();
    } catch {
      // 本文は読まない。
    }
    options.log?.(response.ok ? "notify_sent" : "notify_failed", {
      type: payload.type,
      status: response.status,
    });
  } catch {
    options.log?.("notify_failed", { type: payloadType, status: null });
  }
}
