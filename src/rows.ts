/** BASHIRA は columns / rows（行は配列）と、オブジェクト行のどちらでも読めるようにする。 */
export function rowsToObjects(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const columns = (payload as { columns?: unknown }).columns;
  if (Array.isArray(rows[0]) && Array.isArray(columns) && columns.every((column) => typeof column === "string")) {
    return rows.map((row) => {
      const object: Record<string, unknown> = {};
      const values = row as unknown[];
      (columns as string[]).forEach((column, index) => {
        object[column] = values[index];
      });
      return object;
    });
  }
  if (rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    return rows as Record<string, unknown>[];
  }
  return [];
}

export function payloadNote(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const note = (payload as { note?: unknown }).note;
  return typeof note === "string" ? note : "";
}

export function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

export function numberField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 開催日の日付部分。`YYYY-MM-DD` と、その直後が `T` の時刻付き（`2026-10-12T00:00:00Z`）を受ける。
 * タイムゾーンでは日付を動かさない。日付として読めないときは null。
 */
export function meetingDay(value: string | null): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (value.length !== 10 && value[10] !== "T") return null;
  return day;
}

/** 比較に使う開催日。時刻付きは日付だけにし、日付として読めない文字列はそのまま返す。 */
export function comparableMeetingDay(value: string | null): string | null {
  if (!value) return null;
  return meetingDay(value) ?? value;
}
