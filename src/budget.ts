import { EXTERNAL_BUDGET, EXTERNAL_SUBREQUEST_LIMIT, JobError } from "./types";

/** Worker 呼び出し内の外部 fetch 回数。KV / Queue / DO は Cloudflare 内部なので数えない。 */
export class ExternalBudget {
  used = 0;
  constructor(readonly limit = EXTERNAL_BUDGET) {}

  charge(n = 1): void {
    if (this.used + n > this.limit) {
      throw new JobError(
        `外部サブリクエストが ${this.limit} 件に達したため、この呼び出しを分割して止めました（Free プランの上限は 50）`,
        true,
      );
    }
    this.used += n;
  }

  get remaining(): number {
    return this.limit - this.used;
  }
}

export async function budgetedFetch(
  budget: ExternalBudget,
  input: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  budget.charge(1);
  try {
    return await fetcher(input, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new JobError(`通信に失敗しました: ${message}`, true);
  }
}

/**
 * 通知の 1 件。通常の charge と同じくこの予算に数える。
 * ソフト上限（既定 45）を使い切っていても、プラットフォーム上限 50 の手前なら 1 件だけ足す。
 * テスト用に上限を 45 未満へ下げているとき、および 50 に達しているときは null で fetch しない。
 * 通信失敗は投げる。呼び出し側が握る。
 */
export async function budgetedNotifyFetch(
  budget: ExternalBudget,
  input: string,
  init: RequestInit | undefined,
  fetcher: typeof fetch,
): Promise<Response | null> {
  if (budget.remaining >= 1) return budgetedFetch(budget, input, init, fetcher);
  if (budget.limit < EXTERNAL_BUDGET || budget.used >= EXTERNAL_SUBREQUEST_LIMIT) return null;
  budget.used += 1;
  try {
    return await fetcher(input, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new JobError(`通信に失敗しました: ${message}`, true);
  }
}
