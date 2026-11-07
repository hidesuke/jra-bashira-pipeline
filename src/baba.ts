import { budgetedFetch, ExternalBudget } from "./budget";
import { JobError } from "./types";

/** 失敗レスポンスの本文からログと note に残す長さ。 */
const ERROR_BODY_CHARS = 200;

/**
 * wrangler.jsonc の services バインディング。
 * 同じアカウントの workers.dev へ global fetch すると Worker からは届かず 404 になる。
 */
export interface BabaBinding {
  fetch(request: Request): Promise<Response>;
}

export async function fetchBaba(input: {
  url: string;
  venue: string;
  budget: ExternalBudget;
  /** あるときは env.BABA.fetch(new Request(url))。テストとローカルでは未設定。 */
  binding?: BabaBinding;
  /** バインディングが無いときの fetch。省略時は global fetch。 */
  fetcher?: typeof fetch;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<{ venue: unknown | null; fetchedAt: string | null; note: string | null }> {
  const response = await budgetedFetch(
    input.budget,
    input.url,
    { method: "GET" },
    input.binding ? viaBinding(input.binding, input.url) : input.fetcher,
  );
  if (!response.ok) {
    const body = await errorBody(response);
    const note = `馬場情報の取得に失敗しました（HTTP ${response.status}${body ? ` ${body}` : ""}）。レース処理は続けます`;
    input.log?.("baba_fetch_failed", { status: response.status, body });
    return { venue: null, fetchedAt: null, note };
  }
  const body = (await response.json()) as { fetchedAt?: unknown; venues?: unknown };
  const venues = Array.isArray(body.venues) ? body.venues : [];
  const venue = venues.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { venueName?: unknown }).venueName === input.venue;
  }) ?? null;
  return {
    venue,
    fetchedAt: typeof body.fetchedAt === "string" ? body.fetchedAt : null,
    note: venue ? null : `${input.venue} の馬場情報は latest にありません。レース処理は続けます`,
  };
}

export function babaFailure(err: unknown): { venue: null; fetchedAt: null; note: string } {
  const message = err instanceof JobError ? err.message : err instanceof Error ? err.message : String(err);
  return { venue: null, fetchedAt: null, note: `馬場情報の取得に失敗しました。レース処理は続けます。${message}` };
}

/** サービスバインディングでも budgetedFetch の 1 件に数える。 */
function viaBinding(binding: BabaBinding, url: string): typeof fetch {
  return () => binding.fetch(new Request(url));
}

async function errorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_CHARS);
  } catch {
    return "";
  }
}
