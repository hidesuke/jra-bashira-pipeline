import { acquireLock, releaseLockOwned } from "./pipeline";
import type { JobMessage, KvStore, RaceRef } from "./types";

export interface EnqueueDeps {
  kv: KvStore;
  enqueue(message: JobMessage): Promise<void>;
  now(): Date;
}

/**
 * `POST /run` と開催日バッチが同じ経路で 1 レースを積む。
 * 処理中なら積まない。Queue へ渡せなかったときは、自分が取ったロックだけ外す。
 */
export async function enqueueRace(
  deps: EnqueueDeps,
  input: { race: RaceRef; requestedBy: string; remarks?: string },
): Promise<{ enqueued: true; runId: string } | { enqueued: false; reason: "active" }> {
  const runId = crypto.randomUUID();
  const locked = await acquireLock(deps.kv, input.race.raceKey, runId, input.requestedBy, deps.now());
  if (!locked) return { enqueued: false, reason: "active" };
  try {
    await deps.enqueue({
      kind: "start",
      runId,
      race: input.race,
      requestedBy: input.requestedBy,
      remarks: input.remarks?.trim() ?? "",
    });
  } catch (err) {
    await releaseLockOwned(deps.kv, input.race.raceKey, runId);
    throw err;
  }
  return { enqueued: true, runId };
}
