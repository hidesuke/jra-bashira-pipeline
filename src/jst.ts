/** ISO 時刻を日本時間の `YYYY-MM-DDTHH:mm:ss+09:00` にする。解釈できないときは null。 */
export function formatJst(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}+09:00`;
}

export function formatJstNow(now: Date): string {
  return formatJst(now.toISOString()) ?? now.toISOString();
}

const JST = "Asia/Tokyo";

/** その瞬間の日本時間の暦日。`YYYY-MM-DD`。 */
export function jstCalendarDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 日本時間の曜日。`en-US` の短い名前（`Fri` など）。 */
export function jstWeekday(instant: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: JST, weekday: "short" }).format(instant);
}

/** 暦日を日数だけ動かす。タイムゾーンでは日付を動かさない。 */
export function addCalendarDays(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`日付「${iso}」を読めません`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`日付「${iso}」は暦にありません`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `scheduledTime` の日本時間の翌日。scheduled が積む開催日。 */
export function nextJstDate(instant: Date): string {
  return addCalendarDays(jstCalendarDate(instant), 1);
}
