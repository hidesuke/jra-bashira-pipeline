import type { PredictInputRecord, StoredRelatedCourses } from "./predict-input";
import {
  COURSE_RECORD_UNRESOLVED,
  COURSE_RECORDS_INTRO,
  COURSE_RECORDS_TITLE,
  COURSE_RELATED_EMPTY,
  COURSE_SAME_EMPTY,
  COURSE_TRACK_EMPTY,
  PAST_RUN_COLUMN_COUNT,
  PAST_RUN_HEADER,
  PAST_RUN_NONE,
  PAST_RUN_UNRESOLVED,
  PAST_RUNS_INTRO,
  PAST_RUNS_TITLE,
  RELATED_COURSES_NONE_LINE,
  RELATED_COURSES_UNREADABLE_LINE,
  pastRunHeaderLine,
  pastRunRuleLine,
} from "./past-runs";
import { courseSpecFromText, RELATED_COURSES_MAX, type CourseSpec } from "./related-courses";
import {
  RUNNER_STATS_EMPTY_LINE,
  RUNNER_STATS_HEADING,
  RUNNER_STATS_LOW_SAMPLE,
  RUNNER_STATS_RATE_LINE,
} from "./runner-stats";

const SHAPE_PAST = "保存済みの近10走の形が一致しないため返しません";
const SHAPE_COURSE = "保存済みのコース成績の形が一致しないため返しません";
const SHAPE_RUNNER = "保存済みの出走馬のコース成績の形が一致しないため返しません";
const MISSING_PAST = "保存済みの入力に「# 過去走（近10走）」がありません";
const MISSING_COURSE = "保存済みの入力に「# コース成績」がありません";
const MISSING_RUNNER = `保存済みの入力に「${RUNNER_STATS_HEADING}」がありません`;
const NO_INPUT = "予想入力が保存されていません";
const PAST_CHUNKS = "近10走の分割を最後まで読めませんでした";
const COURSE_CHUNKS = "コース成績の分割を最後まで読めませんでした";
const RUNNER_CHUNKS = "出走馬のコース成績の分割を最後まで読めませんでした";
const RACE_CHUNKS_PAST = "ユーザー文の分割が欠けているため、近10走を取り出せません";
const RACE_CHUNKS_COURSE = "ユーザー文の分割が欠けているため、コース成績を取り出せません";
const RACE_CHUNKS_RUNNER = "ユーザー文の分割が欠けているため、出走馬のコース成績を取り出せません";
const RELATED_MISSING = "関連コースの一覧は保存済みの入力にありません";
const RELATED_UNREADABLE = "関連コースの一覧は読めないまま保存されていて、行の中身は残っていません";
const RELATED_LINE = "保存済みのコース成績から関連コースの行を読めません";

const HORSE_HEADING = /^### (\?|\d+) \S.*$/;

interface RelatedHeader {
  kind: "courses" | "none" | "unreadable";
  courses: CourseSpec[] | null;
  line: string;
}

interface ParsedSection<T> {
  text: string;
  horses: number;
  extra: T;
}

export interface RelatedCoursesView {
  status: "ok" | "absent" | "unclosed" | "malformed" | "unreadable";
  /** 読めた一覧。読めないときは null。空配列は「関連コース: なし」で、0件の成績とは別。 */
  courses: CourseSpec[] | null;
  /** 保存時に 5 件を超えて捨てた行数。古い入力から行だけ読んだときは null。 */
  dropped: number | null;
  /** コース成績に書いた行。原文。 */
  line: string | null;
}

/**
 * 保存済みユーザー文から、近10走の節だけを切り出す。
 * 見出しの次が決まった文で、馬の行がレンダラーと同じときだけ成功する。
 * 形が崩れていたら本文は返さない。
 */
export function extractPastRuns(input: string): { text: string } | { reason: string } {
  const parsed = bestSection(splitLines(input), PAST_RUNS_TITLE, parsePastAt, MISSING_PAST);
  if ("reason" in parsed) return parsed;
  return { text: parsed.text };
}

/** コース成績の節と、その先頭の関連コース行。 */
export function extractCourseRecords(input: string): { text: string; header: RelatedHeader } | { reason: string } {
  const parsed = bestSection(splitLines(input), COURSE_RECORDS_TITLE, parseCourseAt, MISSING_COURSE);
  if ("reason" in parsed) return parsed;
  return { text: parsed.text, header: parsed.extra };
}

/** ユーザー文から、出走馬のコース成績の節だけを切り出す。形が崩れていたら本文は返さない。 */
export function extractRunnerStats(input: string): { text: string } | { reason: string } {
  const parsed = bestSection(splitLines(input), RUNNER_STATS_HEADING, parseRunnerAt, MISSING_RUNNER);
  if ("reason" in parsed) return parsed;
  return { text: parsed.text };
}

/** 空欄の意味。0 や未出走とは別。本文には足さない。 */
export const PAST_RUNS_MISSING_NOTE =
  "空欄は値なしであり、0や未出走ではない。0と書いてあるセルだけがゼロである。レース名の空欄は、競走名が無く、年齢条件とクラスも揃わないため名前を作れなかった走であり、未出走ではない。";

export interface PastRunsMissing {
  /** 表のデータ行数。見出しと区切り行は数えない。 */
  rows: number;
  /** 列名ごとの空欄件数。27列すべて。0 はその列に空欄が無い。 */
  blank: Record<string, number>;
  note: string;
}

/**
 * 返した近10走の空欄を数える。本文は変えない。
 * 表が読めない文字列は行数 0。本文が null のときだけ null。
 */
export function describePastRunsMissing(text: string | null): PastRunsMissing | null {
  if (text == null) return null;
  const blank: Record<string, number> = {};
  for (const name of PAST_RUN_HEADER) blank[name] = 0;
  let rows = 0;
  for (const line of splitLines(text)) {
    if (!isDataRow(line)) continue;
    rows += 1;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    PAST_RUN_HEADER.forEach((name, index) => {
      if (cells[index] === "") blank[name] += 1;
    });
  }
  return { rows, blank, note: PAST_RUNS_MISSING_NOTE };
}

/** include=past_runs のときだけ応答へ足す欄。馬柱とユーザー文は含めない。 */
export function pastRunsSnapshotFields(stored: PredictInputRecord | null): Record<string, unknown> {
  if (!stored) {
    return {
      input_run_id: null,
      saved_at: null,
      past_runs: null,
      past_runs_missing: null,
      course_records: null,
      runner_stats: null,
      related_courses: null,
      past_runs_source: null,
      course_records_source: null,
      runner_stats_source: null,
      related_courses_source: null,
      past_runs_error: NO_INPUT,
      course_records_error: NO_INPUT,
      runner_stats_error: NO_INPUT,
      related_courses_error: NO_INPUT,
    };
  }
  const past = resolvePast(stored);
  const course = resolveCourse(stored);
  const runner = resolveRunner(stored);
  const related = resolveRelated(stored, course.header, course.error);
  return {
    input_run_id: stored.runId,
    saved_at: stored.savedAt,
    past_runs: past.text,
    past_runs_missing: describePastRunsMissing(past.text),
    course_records: course.text,
    runner_stats: runner.text,
    related_courses: related.view,
    past_runs_source: past.source,
    course_records_source: course.source,
    runner_stats_source: runner.source,
    related_courses_source: related.source,
    past_runs_error: past.error,
    course_records_error: course.error,
    runner_stats_error: runner.error,
    related_courses_error: related.error,
  };
}

function resolvePast(stored: PredictInputRecord): { text: string | null; source: "stored" | "extracted" | null; error: string | null } {
  if (stored.pastRunsState === "stored") return { text: stored.pastRuns, source: "stored", error: null };
  if (stored.pastRunsState === "incomplete") return { text: null, source: null, error: PAST_CHUNKS };
  if (stored.raceInputIncomplete) return { text: null, source: null, error: RACE_CHUNKS_PAST };
  const extracted = extractPastRuns(stored.raceInput);
  if ("reason" in extracted) return { text: null, source: null, error: extracted.reason };
  return { text: extracted.text, source: "extracted", error: null };
}

function resolveCourse(stored: PredictInputRecord): {
  text: string | null;
  source: "stored" | "extracted" | null;
  error: string | null;
  header: RelatedHeader | null;
} {
  if (stored.courseRecordsState === "stored") {
    const parsed = stored.courseRecords == null ? null : extractCourseRecords(stored.courseRecords);
    return {
      text: stored.courseRecords,
      source: "stored",
      error: null,
      header: parsed && !("reason" in parsed) ? parsed.header : null,
    };
  }
  if (stored.courseRecordsState === "incomplete") return { text: null, source: null, error: COURSE_CHUNKS, header: null };
  if (stored.raceInputIncomplete) return { text: null, source: null, error: RACE_CHUNKS_COURSE, header: null };
  const extracted = extractCourseRecords(stored.raceInput);
  if ("reason" in extracted) return { text: null, source: null, error: extracted.reason, header: null };
  return { text: extracted.text, source: "extracted", error: null, header: extracted.header };
}

function resolveRunner(stored: PredictInputRecord): { text: string | null; source: "stored" | "extracted" | null; error: string | null } {
  if (stored.runnerStatsState === "stored") return { text: stored.runnerStats, source: "stored", error: null };
  if (stored.runnerStatsState === "incomplete") return { text: null, source: null, error: RUNNER_CHUNKS };
  if (stored.raceInputIncomplete) return { text: null, source: null, error: RACE_CHUNKS_RUNNER };
  const extracted = extractRunnerStats(stored.raceInput);
  if ("reason" in extracted) return { text: null, source: null, error: extracted.reason };
  return { text: extracted.text, source: "extracted", error: null };
}

function resolveRelated(
  stored: PredictInputRecord,
  header: RelatedHeader | null,
  courseError: string | null,
): { view: RelatedCoursesView | null; source: "stored" | "extracted" | null; error: string | null } {
  if (stored.relatedCourses) return { view: relatedFromStored(stored.relatedCourses), source: "stored", error: storedRelatedError(stored.relatedCourses) };
  if (stored.courseRecordsState === "stored" && !header) return { view: null, source: null, error: RELATED_LINE };
  if (!header) return { view: null, source: null, error: courseError ?? RELATED_MISSING };
  if (header.kind === "unreadable") {
    return {
      view: { status: "unreadable", courses: null, dropped: null, line: header.line },
      source: "extracted",
      error: RELATED_UNREADABLE,
    };
  }
  return {
    view: { status: "ok", courses: header.courses, dropped: null, line: header.line },
    source: "extracted",
    error: null,
  };
}

function relatedFromStored(row: StoredRelatedCourses): RelatedCoursesView {
  return {
    status: row.status,
    courses: row.status === "ok" ? row.courses : null,
    dropped: row.dropped,
    line: row.line,
  };
}

function storedRelatedError(row: StoredRelatedCourses): string | null {
  if (row.status === "ok") return null;
  if (row.status === "absent") return "関連コースの一覧はコース分析にありません";
  if (row.status === "unclosed") return "関連コースの一覧が閉じていないため返しません";
  return "関連コースの一覧の行を読めないため返しません";
}

function bestSection<T>(
  lines: string[],
  title: string,
  parse: (lines: string[], start: number) => ParsedSection<T> | { reason: string },
  missing: string,
): ParsedSection<T> | { reason: string } {
  let failure: string | null = null;
  let best: ParsedSection<T> | null = null;
  let seen = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== title) continue;
    seen = true;
    const parsed = parse(lines, index);
    if ("reason" in parsed) {
      failure ??= parsed.reason;
      continue;
    }
    if (!best || parsed.horses > best.horses || (parsed.horses === best.horses && parsed.text.length > best.text.length)) best = parsed;
  }
  if (best) return best;
  if (!seen) return { reason: missing };
  return { reason: failure ?? missing };
}

function parsePastAt(lines: string[], start: number): ParsedSection<undefined> | { reason: string } {
  if (lines[start] !== PAST_RUNS_TITLE || lines[start + 1] !== PAST_RUNS_INTRO) return { reason: SHAPE_PAST };
  const kept = [lines[start]!, lines[start + 1]!];
  const body = consumeHorses(lines, start + 2, SHAPE_PAST, parsePastHorse);
  if ("reason" in body) return body;
  kept.push(...body.lines);
  return { text: kept.join("\n"), horses: body.horses, extra: undefined };
}

const RUNNER_COUNT_DETAIL = new RegExp(
  `^出走 \\d+　勝ち \\d+　勝率 (?:\\d+\\.\\d%|—)　複勝 \\d+　複勝率 (?:\\d+\\.\\d%|—)(?: ${RUNNER_STATS_LOW_SAMPLE})?$`,
);

function parseRunnerAt(lines: string[], start: number): ParsedSection<undefined> | { reason: string } {
  if (lines[start] !== RUNNER_STATS_HEADING) return { reason: SHAPE_RUNNER };
  const second = lines[start + 1];
  if (second == null || forbidden(second)) return { reason: SHAPE_RUNNER };
  if (second === RUNNER_STATS_EMPTY_LINE || isRunnerFailureLine(second)) {
    return { text: `${RUNNER_STATS_HEADING}\n${second}`, horses: 0, extra: undefined };
  }
  if (!/^条件: \S+ (芝|ダート|障害) \d+m$/.test(second)) return { reason: SHAPE_RUNNER };
  const period = lines[start + 2];
  if (period == null || !/^期間: \d{4}-\d{2}-\d{2}〜\d{4}-\d{2}-\d{2}（レース日の前日までの過去\d+年）$/.test(period)) {
    return { reason: SHAPE_RUNNER };
  }
  const kept = [lines[start]!, second, period];
  let index = start + 3;
  const through = lines[index];
  if (through != null && /^確定済みデータは \d{4}-\d{2}-\d{2} まで。$/.test(through)) {
    kept.push(through);
    index += 1;
  }
  const scope = lines[index];
  const rate = lines[index + 1];
  if (scope == null || rate == null || !isScopeLine(scope) || rate !== RUNNER_STATS_RATE_LINE) return { reason: SHAPE_RUNNER };
  kept.push(scope, rate);
  const body = consumeHorses(lines, index + 2, SHAPE_RUNNER, parseRunnerHorse);
  if ("reason" in body) return body;
  kept.push(...body.lines);
  return { text: kept.join("\n"), horses: body.horses, extra: undefined };
}

function parseRunnerHorse(lines: string[], headingIndex: number): { lines: string[]; nextIndex: number } | { reason: string } {
  const heading = lines[headingIndex];
  if (heading == null || !isHorseHeading(heading)) return { reason: SHAPE_RUNNER };
  const sire = lines[headingIndex + 1];
  const broodmare = lines[headingIndex + 2];
  const jockey = lines[headingIndex + 3];
  if (sire == null || broodmare == null || jockey == null) return { reason: SHAPE_RUNNER };
  if (!isRunnerStatLine("父", sire) || !isRunnerStatLine("母父", broodmare) || !isRunnerStatLine("騎手", jockey)) {
    return { reason: SHAPE_RUNNER };
  }
  return { lines: [heading, sire, broodmare, jockey], nextIndex: headingIndex + 4 };
}

function isRunnerStatLine(label: "父" | "母父" | "騎手", line: string): boolean {
  if (forbidden(line)) return false;
  if (line === `${label}: 出馬表に無い`) return true;
  const prefix = `${label} `;
  if (!line.startsWith(prefix)) return false;
  const body = line.slice(prefix.length);
  const splitAt = body.indexOf(": ");
  if (splitAt <= 0) return false;
  const detail = body.slice(splitAt + 2);
  if (detail === "名前が見つからない" || detail === "同名のため特定できない" || detail === "生年付きで指定し直しても特定できない") {
    return true;
  }
  if (/^取得できず（[^）]+）$/.test(detail)) return true;
  return RUNNER_COUNT_DETAIL.test(detail);
}

function isRunnerFailureLine(line: string): boolean {
  return line.startsWith("取得できませんでした（") && line.endsWith("）。") && !forbidden(line) && line.length <= 300;
}

function isScopeLine(line: string): boolean {
  return line.startsWith("scope: ") && !forbidden(line) && line.length <= 240;
}

function parseCourseAt(lines: string[], start: number): ParsedSection<RelatedHeader> | { reason: string } {
  if (lines[start] !== COURSE_RECORDS_TITLE || lines[start + 1] !== COURSE_RECORDS_INTRO) return { reason: SHAPE_COURSE };
  const headerLine = lines[start + 2];
  if (headerLine == null || forbidden(headerLine)) return { reason: SHAPE_COURSE };
  const header = parseRelatedHeader(headerLine);
  if (!header) return { reason: SHAPE_COURSE };
  const kept = [lines[start]!, lines[start + 1]!, headerLine];
  const body = consumeHorses(lines, start + 3, SHAPE_COURSE, parseCourseHorse);
  if ("reason" in body) return body;
  kept.push(...body.lines);
  return { text: kept.join("\n"), horses: body.horses, extra: header };
}

/**
 * 馬の塊は空行のあとにだけ続く。空行の次が馬の見出しでなければ、そこで節は終わる。
 * 空行なしで続く説明や次の見出しは含めない。表の行が途中で崩れていたら、節ごと失敗する。
 */
function consumeHorses(
  lines: string[],
  start: number,
  shape: string,
  parseHorse: (lines: string[], headingIndex: number) => { lines: string[]; nextIndex: number } | { reason: string },
): { lines: string[]; horses: number } | { reason: string } {
  const kept: string[] = [];
  let index = start;
  let horses = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line === "") {
      const next = lines[index + 1];
      if (next == null || !isHorseHeading(next)) break;
      const horse = parseHorse(lines, index + 1);
      if ("reason" in horse) return horse;
      kept.push("", ...horse.lines);
      horses += 1;
      index = horse.nextIndex;
      continue;
    }
    // 表の途中が欠けた行は、途中までを成功にしない。
    if (line.startsWith("|")) return { reason: shape };
    // 空行なしの説明文や次の見出しは、この節の外なので含めない。
    break;
  }
  return { lines: kept, horses };
}

function parsePastHorse(lines: string[], headingIndex: number): { lines: string[]; nextIndex: number } | { reason: string } {
  const heading = lines[headingIndex];
  if (heading == null || !isHorseHeading(heading)) return { reason: SHAPE_PAST };
  const first = lines[headingIndex + 1];
  if (first == null || forbidden(first)) return { reason: SHAPE_PAST };
  if (first === PAST_RUN_UNRESOLVED || first === PAST_RUN_NONE) return { lines: [heading, first], nextIndex: headingIndex + 2 };
  if (first !== pastRunHeaderLine() || lines[headingIndex + 2] !== pastRunRuleLine()) return { reason: SHAPE_PAST };
  const body = [heading, first, lines[headingIndex + 2]!];
  let index = headingIndex + 3;
  if (!isDataRow(lines[index] ?? "")) return { reason: SHAPE_PAST };
  while (index < lines.length && isDataRow(lines[index]!)) {
    body.push(lines[index]!);
    index += 1;
  }
  return { lines: body, nextIndex: index };
}

function parseCourseHorse(lines: string[], headingIndex: number): { lines: string[]; nextIndex: number } | { reason: string } {
  const heading = lines[headingIndex];
  if (heading == null || !isHorseHeading(heading)) return { reason: SHAPE_COURSE };
  const first = lines[headingIndex + 1];
  if (first == null || forbidden(first)) return { reason: SHAPE_COURSE };
  if (first === COURSE_RECORD_UNRESOLVED) {
    const same = lines[headingIndex + 2];
    const track = lines[headingIndex + 3];
    const related = lines[headingIndex + 4];
    if (same !== COURSE_SAME_EMPTY || track !== COURSE_TRACK_EMPTY || related !== COURSE_RELATED_EMPTY) return { reason: SHAPE_COURSE };
    return { lines: [heading, first, same, track, related], nextIndex: headingIndex + 5 };
  }
  const track = lines[headingIndex + 2];
  const related = lines[headingIndex + 3];
  if (track == null || related == null) return { reason: SHAPE_COURSE };
  if (!isCountLine("同じコース", first) || !isCountLine("同じ競馬場", track) || !isCountLine("関連コース", related)) return { reason: SHAPE_COURSE };
  return { lines: [heading, first, track, related], nextIndex: headingIndex + 4 };
}

function parseRelatedHeader(line: string): RelatedHeader | null {
  if (line === RELATED_COURSES_UNREADABLE_LINE) return { kind: "unreadable", courses: null, line };
  if (line === RELATED_COURSES_NONE_LINE) return { kind: "none", courses: [], line };
  const prefix = "関連コース: ";
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  if (rest === "" || forbidden(rest)) return null;
  const parts = rest.split(" / ");
  if (parts.length < 1 || parts.length > RELATED_COURSES_MAX) return null;
  const courses: CourseSpec[] = [];
  for (const part of parts) {
    const course = courseSpecFromText(part);
    if (!course) return null;
    courses.push(course);
  }
  return { kind: "courses", courses, line };
}

function isCountLine(label: "同じコース" | "同じ競馬場" | "関連コース", line: string): boolean {
  if (forbidden(line) || !line.startsWith(`${label}: `)) return false;
  const rest = line.slice(label.length + 2);
  return rest === "" || /^\(\d+,\d+,\d+,\d+,\d+,\d+\)$/.test(rest);
}

function isHorseHeading(line: string): boolean {
  return HORSE_HEADING.test(line) && !forbidden(line);
}

function isDataRow(line: string): boolean {
  if (forbidden(line) || line === pastRunHeaderLine() || line === pastRunRuleLine()) return false;
  if (!line.startsWith("|") || !line.endsWith("|")) return false;
  return line.slice(1, -1).split("|").length === PAST_RUN_COLUMN_COUNT;
}

function forbidden(line: string): boolean {
  return line.includes("{{") || line.includes("<<<");
}

function splitLines(input: string): string[] {
  return input.split(/\r?\n/);
}
