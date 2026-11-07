import { budgetedFetch, ExternalBudget } from "./budget";
import { JobError } from "./types";

export async function fetchBaba(input: {
  url: string;
  venue: string;
  budget: ExternalBudget;
  fetcher?: typeof fetch;
}): Promise<{ venue: unknown | null; fetchedAt: string | null; note: string | null }> {
  const response = await budgetedFetch(input.budget, input.url, { method: "GET" }, input.fetcher);
  if (!response.ok) {
    return { venue: null, fetchedAt: null, note: `馬場情報の取得に失敗しました（HTTP ${response.status}）。レース処理は続けます` };
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
