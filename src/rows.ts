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
