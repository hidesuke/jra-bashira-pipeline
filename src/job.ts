import type { CourseSummaryRecord } from "./course-summary";
import type { ConsistencyWarning } from "./consistency";
import type { FormTask } from "./form";
import type { OddsSummary } from "./odds";
import type { StatTask } from "./stats";
import { keys, kvGetJson, kvPutJson, sleepMs } from "./kv";
import type { KvStore, RaceRef } from "./types";

/** 同じジョブキーへの書き込み間隔。KV の 1 秒制限より少し長く取る。 */
export const JOB_WRITE_MIN_INTERVAL_MS = 1_100;

export interface StoredPrediction {
  courseText: string;
  courseModel: string;
  raceModel: string;
  courseModelVersion: string | null;
  raceModelVersion: string | null;
  coursePromptVersion: string;
  racePromptVersion: string;
  指数分布: string;
  自信度: string;
  波乱度: string;
  印: string;
  予想本文: string;
}

export interface JobState {
  runId: string;
  race: RaceRef;
  requestedBy: string;
  phase: "collect" | "form" | "stats" | "predict" | "notion" | "done" | "error";
  error?: string;
  /** Dify の備考。無ければ空。 */
  remarks: string;
  baba: unknown;
  raceRow: Record<string, unknown> | null;
  entries: Record<string, unknown>[];
  /** 馬ごとの近10走。 */
  formTasks: FormTask[];
  odds: OddsSummary | null;
  /** 内・外のデータは無い。常に null。 */
  courseVariant: null;
  /**
   * コース分析に渡すコースデータ要約。未計算のジョブでは未設定。
   * 失敗しても予想は続け、error に理由を残す。
   */
  courseSummary?: CourseSummaryRecord | null;
  statTasks: StatTask[];
  prediction: StoredPrediction | null;
  notionPageId: string | null;
  /** 本文を書き終えたあとアーカイブする旧ページ。新規だけなら null。 */
  notionArchivePageId?: string | null;
  /** 新しいページに書き終えた子ブロック数。再開時は残りだけ足す。 */
  notionBlocksWritten?: number;
  /** サブリクエスト分割で Notion 段を積み直した回数。 */
  notionContinuations?: number;
  /** 予想本文と成績の食い違い。Notion には書かない。未実施のジョブでは未設定。 */
  consistencyWarnings?: ConsistencyWarning[];
  /** 予想入力を別キーへ書いた結果。本文そのものは入れない。 */
  predictInput?: {
    stored: boolean;
    truncated: boolean;
    umabashiraBytes: number;
    raceInputBytes: number;
  };
  updatedAt: string;
}

export async function loadJob(kv: KvStore, raceKey: string): Promise<JobState | null> {
  return kvGetJson<JobState>(kv, keys.job(raceKey));
}

export async function saveJob(
  kv: KvStore,
  state: JobState,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  await kvPutJson(kv, keys.job(state.race.raceKey), state, undefined, sleep);
}

/**
 * 1 配送のあいだ、ジョブ状態はメモリに置き、同じキーは約 1 秒に 1 回だけ KV へ書く。
 * バッチの途中は間隔が空いたときだけ残し、終わりは必ず書く（直前の書き込みから 1.1 秒未満なら待つ）。
 */
export class JobWriter {
  private lastWriteMs: number | null = null;
  private readonly startedMs: number;

  constructor(
    private readonly kv: KvStore,
    private readonly nowMs: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = sleepMs,
  ) {
    this.startedMs = nowMs();
  }

  hasWritten(): boolean {
    return this.lastWriteMs != null;
  }

  /** 直前の書き込み（無ければこの配送の開始）から 1.1 秒以上経っていれば書く。 */
  async saveIfDue(state: JobState): Promise<void> {
    const now = this.nowMs();
    const anchor = this.lastWriteMs ?? this.startedMs;
    if (now - anchor < JOB_WRITE_MIN_INTERVAL_MS) return;
    await this.write(state);
  }

  /** 最新の状態を必ず残す。間隔が足りなければ 1.1 秒が空くまで待つ。 */
  async flush(state: JobState): Promise<void> {
    const now = this.nowMs();
    if (this.lastWriteMs != null && now - this.lastWriteMs < JOB_WRITE_MIN_INTERVAL_MS) {
      await this.sleep(JOB_WRITE_MIN_INTERVAL_MS - (now - this.lastWriteMs));
    }
    await this.write(state);
  }

  private async write(state: JobState): Promise<void> {
    await saveJob(this.kv, state, this.sleep);
    this.lastWriteMs = this.nowMs();
  }
}
