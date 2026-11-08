import { formatJst } from "./jst";
import { numberField, payloadNote, rowsToObjects, stringField } from "./rows";

export type OddsReason = "未発売" | "発売票数なし" | "取得エラー" | "オッズのデータが無い";

export interface OddsHorse {
  horseNumber: number | null;
  selection: string | null;
  odds: number | null;
  oddsMin: number | null;
  oddsMax: number | null;
  status: string | null;
  kind: string | null;
  observedAtJst: string | null;
}

export interface OddsSummary {
  source: "get_odds" | "entries" | "none";
  available: boolean;
  kind: string | null;
  observedAtJst: string | null;
  reason: OddsReason | null;
  detail: string | null;
  horses: OddsHorse[];
}

const STALE_LIVE_MS = 6 * 60 * 60 * 1000;

export function interpretOdds(input: {
  getOdds: { ok: true; payload: unknown } | { ok: false; message: string };
  entryRows: Record<string, unknown>[];
  now: Date;
}): OddsSummary {
  if (!input.getOdds.ok) {
    const fromEntries = summaryFromHorses("entries", horsesFromEntries(input.entryRows), null);
    if (fromEntries.available) {
      return {
        ...fromEntries,
        reason: null,
        detail: `get_odds に失敗したため、出馬表の単勝オッズを使いました: ${input.getOdds.message}`,
      };
    }
    const reason: OddsReason = /未発売/.test(input.getOdds.message) ? "未発売" : "取得エラー";
    return empty(reason, input.getOdds.message);
  }

  const payload = input.getOdds.payload;
  const note = payloadNote(payload);
  const rows = rowsToObjects(payload);
  if (rows.length === 0) {
    if (/データが無|2007-07-28/.test(note)) return empty("オッズのデータが無い", note);
    const live = payload && typeof payload === "object" ? (payload as { live_as_of?: unknown }).live_as_of : null;
    if (typeof live === "string") {
      const age = input.now.getTime() - new Date(live).getTime();
      if (Number.isFinite(age) && age > STALE_LIVE_MS) {
        return empty("取得エラー", `行が無く live_as_of が古い（${live}）。取り込みの問題の可能性があります。`);
      }
    }
    return empty("未発売", note || "オッズの行がありません。発売前の可能性があります。");
  }

  const horses = rows.map(horseFromOddsRow);
  const summary = summaryFromHorses("get_odds", horses, note);
  if (!summary.available) {
    const onlyNoBets = horses.length > 0 && horses.every((horse) => horse.odds == null && horse.oddsMin == null && horse.status === "no_bets");
    return {
      ...summary,
      reason: onlyNoBets ? "発売票数なし" : "未発売",
      detail: note || (onlyNoBets ? "発売票数なし（no_bets）" : "倍率のある行がありません"),
    };
  }
  return summary;
}

function summaryFromHorses(source: OddsSummary["source"], horses: OddsHorse[], note: string | null): OddsSummary {
  const kinds = unique(horses.map((horse) => horse.kind));
  const times = horses.map((horse) => horse.observedAtJst).filter((value): value is string => Boolean(value));
  const available = horses.some((horse) => horse.odds != null || horse.oddsMin != null);
  return {
    source,
    available,
    kind: kinds.length > 0 ? kinds.join(" / ") : null,
    observedAtJst: times.sort().at(-1) ?? null,
    reason: null,
    detail: note,
    horses,
  };
}

function horseFromOddsRow(row: Record<string, unknown>): OddsHorse {
  const selection = stringField(row, "selection");
  const horseNumber = numberField(row, "horse_number") ?? leadingNumber(selection);
  return {
    horseNumber,
    selection,
    odds: numberField(row, "odds"),
    oddsMin: numberField(row, "odds_min"),
    oddsMax: numberField(row, "odds_max"),
    status: stringField(row, "status"),
    kind: stringField(row, "odds_kind"),
    observedAtJst: formatJst(stringField(row, "odds_observed_at")),
  };
}

function horsesFromEntries(rows: Record<string, unknown>[]): OddsHorse[] {
  return rows.map((row) => ({
    horseNumber: numberField(row, "horse_number"),
    selection: null,
    odds: numberField(row, "win_odds"),
    oddsMin: null,
    oddsMax: null,
    status: null,
    kind: stringField(row, "odds_kind"),
    observedAtJst: formatJst(stringField(row, "odds_observed_at")),
  }));
}

/**
 * レース予想の `{{win_odds}}`。取れない馬はコロンのあとが空。
 * 観測時刻は最も遅い odds_observed_at を日本時間にしたもの。
 */
export function renderWinOddsText(entries: Record<string, unknown>[], odds: OddsSummary | null): string {
  const byNumber = new Map<number, OddsHorse>();
  for (const horse of odds?.horses ?? []) {
    if (horse.horseNumber != null && !byNumber.has(horse.horseNumber)) byNumber.set(horse.horseNumber, horse);
  }
  const horses = [...entries].sort((a, b) => (numberField(a, "horse_number") ?? 99) - (numberField(b, "horse_number") ?? 99));
  const lines = horses.map((entry) => {
    const number = numberField(entry, "horse_number");
    const name = stringField(entry, "horse_name") ?? "馬名不明";
    const label = number == null ? name : `${trimNum(number)} ${name}`;
    const horse = number == null ? undefined : byNumber.get(number);
    return `${label}: ${horse ? formatPrice(horse) : ""}`;
  });
  return ["# 単勝オッズ", `観測時刻: ${odds?.observedAtJst ?? ""}`, `種別: ${odds?.kind ?? ""}`, ...lines].join("\n");
}

function formatPrice(horse: OddsHorse): string {
  if (horse.odds != null) return trimNum(horse.odds);
  if (horse.oddsMin != null || horse.oddsMax != null) {
    return `${horse.oddsMin == null ? "" : trimNum(horse.oddsMin)}〜${horse.oddsMax == null ? "" : trimNum(horse.oddsMax)}`;
  }
  return "";
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function empty(reason: OddsReason, detail: string | null): OddsSummary {
  return {
    source: "none",
    available: false,
    kind: null,
    observedAtJst: null,
    reason,
    detail,
    horses: [],
  };
}

function leadingNumber(selection: string | null): number | null {
  if (!selection) return null;
  const match = /^(\d+)/.exec(selection);
  return match ? Number(match[1]) : null;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
