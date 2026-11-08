/** 開発モードは 1 レース。Free プランの外部サブリクエスト上限は 50。 */
export const EXTERNAL_SUBREQUEST_LIMIT = 50;
/** リダイレクト分の余裕を残し、Worker 側の fetch はここまで。 */
export const EXTERNAL_BUDGET = 45;
/** Durable Object 1 回の外部 fetch 上限。プラットフォーム上限 50 より手前で止める。 */
export const DO_EXTERNAL_BUDGET = 40;
/** 1 キューメッセージで DO に渡す get_stats の件数。 */
export const STATS_BATCH_SIZE = 8;
export const STATS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
export const LOCK_TTL_SECONDS = 15 * 60;
/** wrangler.jsonc の queues.consumers.max_retries と同じ。 */
export const QUEUE_MAX_RETRIES = 3;
export const BASHIRA_MARKER = "BASHIRAで取得";
export const DEFAULT_MODEL_NAME = "gemini-flash-latest";

export const VENUE_BY_CODE: Record<string, string> = {
  "01": "札幌",
  "02": "函館",
  "03": "福島",
  "04": "新潟",
  "05": "東京",
  "06": "中山",
  "07": "中京",
  "08": "京都",
  "09": "阪神",
  "10": "小倉",
};

export const CODE_BY_VENUE: Record<string, string> = Object.fromEntries(
  Object.entries(VENUE_BY_CODE).map(([code, name]) => [name, code]),
);

export interface RaceRef {
  raceKey: string;
  raceId: string;
  date: string;
  venue: string;
  venueCode: string;
  raceNumber: number;
}

export interface KvListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** 日付のジョブ一覧。本番の KV バインディングは list を持つ。 */
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult>;
}

export type JobMessage =
  | { kind: "start"; runId: string; race: RaceRef; requestedBy: string; remarks?: string }
  | { kind: "form"; runId: string; raceKey: string }
  | { kind: "stats"; runId: string; raceKey: string }
  | { kind: "predict"; runId: string; raceKey: string }
  | { kind: "notion"; runId: string; raceKey: string };

export class JobError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "JobError";
    this.retryable = retryable;
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof JobError ? err.retryable : true;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
