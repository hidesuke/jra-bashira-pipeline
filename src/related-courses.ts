/** コース分析の末尾に付く関連コース一覧。プロンプト本文はここに置かない。 */

export const RELATED_COURSES_OPEN = "<<<related-courses>>>";
export const RELATED_COURSES_CLOSE = "<<<end>>>";
/** プロンプト側の上限。超えた分は数えない。 */
export const RELATED_COURSES_MAX = 5;

const SURFACES = new Set(["芝", "ダート", "障害"]);

export interface CourseSpec {
  track: string;
  surface: string;
  distance: number;
}

export type RelatedCoursesStatus = "absent" | "ok" | "unclosed" | "malformed";

export interface RelatedCoursesParse {
  status: RelatedCoursesStatus;
  /** status が ok のときだけ使う。最大 5 件。重複は除く。 */
  courses: CourseSpec[];
  /** 5 件を超えて捨てた行数。status は ok のまま。 */
  dropped: number;
}

export function relatedCoursesGap(parse: RelatedCoursesParse): string | null {
  if (parse.status === "absent") return "関連コース（コース分析に一覧が無い）";
  if (parse.status === "unclosed") return "関連コース（<<<end>>> が無い）";
  if (parse.status === "malformed") return "関連コース（一覧の行を読めない）";
  if (parse.dropped > 0) return `関連コース（${parse.courses.length + 1}件目以降は数えない）`;
  return null;
}

export function parseRelatedCourses(text: string): RelatedCoursesParse {
  const lines = splitLines(text);
  const open = lines.findIndex((line) => line.trim() === RELATED_COURSES_OPEN);
  if (open < 0) return { status: "absent", courses: [], dropped: 0 };
  const close = lines.findIndex((line, index) => index > open && line.trim() === RELATED_COURSES_CLOSE);
  if (close < 0) return { status: "unclosed", courses: [], dropped: 0 };
  const courses: CourseSpec[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(open + 1, close)) {
    if (line.trim() === "") continue;
    const course = parseCourseLine(line);
    if (!course) return { status: "malformed", courses: [], dropped: 0 };
    const key = `${course.track}\0${course.surface}\0${course.distance}`;
    if (seen.has(key)) continue;
    seen.add(key);
    courses.push(course);
  }
  if (courses.length > RELATED_COURSES_MAX) {
    return { status: "ok", courses: courses.slice(0, RELATED_COURSES_MAX), dropped: courses.length - RELATED_COURSES_MAX };
  }
  return { status: "ok", courses, dropped: 0 };
}

/**
 * 閉じたブロックと、その前後の空行を除く。
 * 閉じタグが無いときは本文を削らない。
 */
export function stripRelatedCourses(text: string): { text: string; parse: RelatedCoursesParse } {
  const parse = parseRelatedCourses(text);
  if (parse.status === "absent" || parse.status === "unclosed") return { text, parse };
  const lines = splitLines(text);
  const open = lines.findIndex((line) => line.trim() === RELATED_COURSES_OPEN);
  const close = lines.findIndex((line, index) => index > open && line.trim() === RELATED_COURSES_CLOSE);
  let start = open;
  let end = close + 1;
  while (start > 0 && lines[start - 1]!.trim() === "") start -= 1;
  while (end < lines.length && lines[end]!.trim() === "") end += 1;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  let next: string;
  if (before.length > 0 && after.length > 0) next = [...before, "", ...after].join("\n");
  else next = [...before, ...after].join("\n");
  if (text.endsWith("\n") && next !== "" && !next.endsWith("\n") && after.length > 0) next += "\n";
  return { text: next, parse };
}

function parseCourseLine(line: string): CourseSpec | null {
  const parts = line.trim().split(",");
  if (parts.length !== 3) return null;
  const track = parts[0]!.trim();
  const surface = parts[1]!.trim();
  const distanceText = parts[2]!.trim();
  if (!track || !SURFACES.has(surface) || !/^\d+$/.test(distanceText)) return null;
  const distance = Number(distanceText);
  if (!Number.isInteger(distance) || distance < 1 || distance > 99999) return null;
  return { track, surface, distance };
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}
