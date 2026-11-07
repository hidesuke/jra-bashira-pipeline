import { EXTERNAL_BUDGET, JobError } from "./types";

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
