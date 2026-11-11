import {
  EMPTY_COURSE_SIDE,
  MISSING_COURSE_SIDE,
  UNREADABLE_COURSE_SIDE,
  unresolvedCourseSide,
  type CourseSideState,
} from "./course-side";
import { numberField, stringField } from "./rows";

/** 出走取消・発走除外・競走除外。pipeline の出馬表と同じ区分。 */
const SCRATCHED = new Set(["出走取消", "発走除外", "競走除外"]);

/** tools/list に course_side が無いとき。以前の空欄と同じ文言。 */
export const MISSING_INNER_OUTER = MISSING_COURSE_SIDE;
export const MISSING_TEMPORARY_RAIL = "仮柵（BASHIRA に項目が無い）";

const NOTE_ABSENT =
  "注: 内外回りと仮柵は BASHIRA に項目が無い。コースは rail_type（A〜D。Aは本柵、B〜Dは移動柵）だけを書き、内・外には読み替えない。";

const NOTE_KNOWN =
  "注: 内外回りは BASHIRA の course_side。値は 内、外、外→内、内→外、なし。外→内と内→外は途中で回りが変わる。なしは印が無い。仮柵は項目が無い。コースの A〜D は rail_type（Aは本柵、B〜Dは移動柵）で、内・外には読み替えない。";

const NOTE_EMPTY =
  "注: 内外回りの値は無い。仮柵は項目が無い。コースの A〜D は rail_type（Aは本柵、B〜Dは移動柵）で、内・外には読み替えない。";

const NOTE_UNREADABLE =
  "注: 内外回りの値が読めないため空欄にした。仮柵は項目が無い。コースの A〜D は rail_type（Aは本柵、B〜Dは移動柵）で、内・外には読み替えない。";

export interface RaceFacts {
  text: string;
  /** 空欄にした項目。処理は続ける。 */
  gaps: string[];
}

/**
 * レース予想に足すレース単位の事実。値は既に取った get_races と出馬表だけを使う。
 * 無い項目は空欄にし、gaps に名前を残す。オッズは書かない。
 */
export function buildRaceFacts(input: {
  raceRow: Record<string, unknown> | null;
  entries: Record<string, unknown>[];
  /** 省略時は、course_side が無いときの空欄。 */
  courseSide?: CourseSideState;
}): RaceFacts {
  const row = input.raceRow;
  const courseSide = input.courseSide ?? unresolvedCourseSide();
  const gaps: string[] = [];
  if (courseSide.gap) gaps.push(courseSide.gap);
  gaps.push(MISSING_TEMPORARY_RAIL);
  const name = row ? stringField(row, "race_name_main") : null;
  const grade = row ? stringField(row, "grade") : null;
  const klass = row ? stringField(row, "race_condition") : null;
  const kind = row ? stringField(row, "race_type") : null;
  const rail = row ? stringField(row, "rail_type") : null;
  const weightType = row ? stringField(row, "weight_type") : null;
  const post = formatPostTime(row ? stringField(row, "post_time") : null);
  if (!name) gaps.push("レース名");
  if (!grade) gaps.push("グレード");
  if (!klass) gaps.push("クラス");
  if (!kind) gaps.push("競走種別");
  const heads = headCount(row, input.entries, gaps);
  if (!rail) gaps.push("コース");
  if (!weightType) gaps.push("斤量種別");
  if (!post) gaps.push("発走時刻");
  const lines = [
    "# レース情報",
    `レース名: ${name ?? ""}`,
    `グレード: ${grade ?? ""}`,
    `クラス: ${klass ?? ""}`,
    `競走種別: ${kind ?? ""}`,
    `頭数: ${heads}`,
    `コース: ${rail ? `${rail}コース` : ""}`,
    `内外回り: ${courseSide.side ?? ""}`,
    "仮柵: ",
    `斤量種別: ${weightType ?? ""}`,
    `発走時刻: ${post ?? ""}`,
    factsNote(courseSide),
  ];
  return { text: lines.join("\n"), gaps };
}

/** `15:30:00` は `15:30`。秒が 00 でなければ残す。読めない文字列はそのまま。 */
export function formatPostTime(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return value.trim();
  const hour = match[1]!.padStart(2, "0");
  const minute = match[2]!;
  const second = match[3];
  if (!second || second === "00") return `${hour}:${minute}`;
  return `${hour}:${minute}:${second}`;
}

function factsNote(state: CourseSideState): string {
  if (state.side) return NOTE_KNOWN;
  if (state.gap === EMPTY_COURSE_SIDE) return NOTE_EMPTY;
  if (state.gap === UNREADABLE_COURSE_SIDE) return NOTE_UNREADABLE;
  return NOTE_ABSENT;
}

function headCount(row: Record<string, unknown> | null, entries: Record<string, unknown>[], gaps: string[]): string {
  const scheduled = row ? numberField(row, "scheduled_horse_count") : null;
  const starters = row ? numberField(row, "starters") : null;
  const active = entries.filter((entry) => !SCRATCHED.has(stringField(entry, "race_abnormality") ?? "")).length;
  const parts: string[] = [];
  if (scheduled == null) gaps.push("出走予定頭数");
  else parts.push(`予定${trimNum(scheduled)}`);
  if (starters == null) {
    gaps.push("出走頭数（starters）");
    if (entries.length > 0) parts.push(`出走${active}（取消・除外を反映。starters が空なので出馬表から数えた）`);
  } else {
    let text = `出走${trimNum(starters)}（取消・除外を反映）`;
    if (entries.length > 0 && active !== starters) text += `。出馬表では出走${active}`;
    parts.push(text);
  }
  if (parts.length === 0) {
    gaps.push("頭数");
    return "";
  }
  return parts.join(" / ");
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
