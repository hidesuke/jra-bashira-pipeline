import { CODE_BY_VENUE, JobError, VENUE_BY_CODE, type RaceRef } from "./types";

const RACE_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})-(\d{2})$/;

export interface RaceRequestBody {
  race_id?: unknown;
  date?: unknown;
  venue?: unknown;
  race_number?: unknown;
  races?: unknown;
}

export function parseRaceRequest(body: RaceRequestBody): RaceRef {
  if (Array.isArray(body.races)) {
    throw new JobError("1 回のリクエストでは 1 レースだけ受け付けます", false);
  }
  const fromId = body.race_id == null ? null : parseRaceId(body.race_id);
  const fromParts = hasParts(body) ? parseParts(body) : null;
  if (!fromId && !fromParts) {
    throw new JobError("race_id（YYYYMMDD-場コード-レース番号）か、date・venue・race_number を指定してください", false);
  }
  if (fromId && fromParts && !sameRace(fromId, fromParts)) {
    throw new JobError("race_id と date・venue・race_number が一致しません。片方だけ指定してください", false);
  }
  return fromId ?? fromParts!;
}

function hasParts(body: RaceRequestBody): boolean {
  return body.date != null || body.venue != null || body.race_number != null;
}

function parseRaceId(value: unknown): RaceRef {
  if (typeof value !== "string") {
    throw new JobError("race_id は文字列です", false);
  }
  const match = RACE_ID.exec(value.trim());
  if (!match) {
    throw new JobError("race_id は YYYYMMDD-場コード2桁-レース番号2桁 です（例: 20261107-03-11）", false);
  }
  const [, year, month, day, code, race] = match;
  const venue = VENUE_BY_CODE[code];
  if (!venue) throw new JobError(`場コード ${code} は JRA の 01〜10 ではありません`, false);
  const raceNumber = Number(race);
  assertRaceNumber(raceNumber);
  const date = `${year}-${month}-${day}`;
  assertDate(date);
  return {
    raceKey: `${year}${month}${day}-${code}-${race}`,
    raceId: `${year}${month}${day}-${code}-${race}`,
    date,
    venue,
    venueCode: code,
    raceNumber,
  };
}

function parseParts(body: RaceRequestBody): RaceRef {
  if (typeof body.date !== "string" || typeof body.venue !== "string") {
    throw new JobError("date（YYYY-MM-DD）と venue（競馬場名）と race_number をすべて指定してください", false);
  }
  assertDate(body.date);
  const venue = body.venue.replace(/競馬場$/, "");
  const code = CODE_BY_VENUE[venue];
  if (!code) throw new JobError(`開催場「${body.venue}」は JRA 10 場の名前ではありません`, false);
  const raceNumber = typeof body.race_number === "number" ? body.race_number : Number(body.race_number);
  if (!Number.isInteger(raceNumber)) throw new JobError("race_number は整数です", false);
  assertRaceNumber(raceNumber);
  const [year, month, day] = body.date.split("-");
  const race = String(raceNumber).padStart(2, "0");
  const raceId = `${year}${month}${day}-${code}-${race}`;
  return { raceKey: raceId, raceId, date: body.date, venue, venueCode: code, raceNumber };
}

function assertRaceNumber(raceNumber: number): void {
  if (raceNumber < 1 || raceNumber > 12) {
    throw new JobError("レース番号は 1〜12 です（Notion の「レース」の選択肢もこの範囲です）", false);
  }
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new JobError("日付は YYYY-MM-DD です", false);
  }
}

function sameRace(a: RaceRef, b: RaceRef): boolean {
  return a.raceKey === b.raceKey;
}
