import type { FormTask } from "./form";
import { numberField, stringField } from "./rows";
import type { RaceRef } from "./types";

const SCRATCHED = new Set(["出走取消", "発走除外", "競走除外"]);

export const UMABASHIRA_LIMITS = [
  "各馬の近走は最大10走。get_entries を馬名で race_meeting_date 降順に取り、今回のレースと upcoming を除いた残りを使う。10走未満なら返った走だけを書く。",
  "着差は time_difference_with_winner_sec（秒。勝者が負、敗者が正）。馬身（ハナ・アタマ・クビ等）は BASHIRA に無い。",
  "頭数は scheduled_horse_count（出走予定頭数）。確定頭数は get_entries に無い。",
  "通過順は馬ごとの 1〜4 角順位。レース単位の通過順文字列、各近走のラップ、調教タイムは無い。",
].join("\n");

export function renderUmabashira(input: {
  race: RaceRef;
  entries: Record<string, unknown>[];
  formTasks: FormTask[];
}): string {
  const forms = new Map(input.formTasks.map((task) => [task.horseName, task]));
  const horses = [...input.entries].sort((a, b) => (numberField(a, "horse_number") ?? 99) - (numberField(b, "horse_number") ?? 99));
  const blocks = horses.map((entry) => horseBlock(entry, forms.get(stringField(entry, "horse_name") ?? "")));
  return ["# 馬柱", UMABASHIRA_LIMITS, ...blocks].join("\n\n");
}

export function formatPastRun(row: Record<string, unknown>): string {
  const place = placeLabel(row);
  const margin = numberField(row, "time_difference_with_winner_sec");
  const last3 = numberField(row, "last_3f_sec");
  const last3Rank = numberField(row, "last_3f_rank");
  const overseas = stringField(row, "local_overseas_type");
  const parts = [
    stringField(row, "race_meeting_date") ?? "日付不明",
    courseLabel(row),
    stringField(row, "track_condition") ?? "馬場不明",
    classLabel(row),
    `${place}`,
    `頭数${numberField(row, "scheduled_horse_count") ?? "—"}`,
    `時計${formatTime(numberField(row, "finish_time_sec"))}`,
    `着差${margin == null ? "—" : `${trimNum(margin)}秒`}`,
    `通過${passing(row)}`,
    `上り${last3 == null ? "—" : trimNum(last3)}${last3Rank == null ? "" : `(${trimNum(last3Rank)}位)`}`,
    `騎手 ${stringField(row, "jockey_name") ?? "—"}`,
    `斤量 ${numberField(row, "weight_to_carry_kg") ?? "—"}`,
    `人気 ${numberField(row, "win_odds_rank") ?? "—"}`,
    `単勝 ${numberField(row, "win_odds") ?? "—"}`,
  ];
  if (overseas && overseas !== "JRA") parts.push(overseas);
  const weather = stringField(row, "weather");
  if (weather) parts.push(weather);
  return `- ${parts.join(" / ")}`;
}

function horseBlock(entry: Record<string, unknown>, task: FormTask | undefined): string {
  const number = numberField(entry, "horse_number") ?? "?";
  const name = stringField(entry, "horse_name") ?? "馬名不明";
  const sex = stringField(entry, "horse_sex") ?? "";
  const age = numberField(entry, "horse_age");
  const bracket = numberField(entry, "bracket_number");
  const weight = numberField(entry, "weight_to_carry_kg");
  const jockey = stringField(entry, "jockey_name") ?? "騎手不明";
  const profile = [sex, age == null ? "" : String(age), bracket == null ? "" : `${bracket}枠`, weight == null ? "" : `${trimNum(weight)}kg`, jockey]
    .filter((part) => part !== "")
    .join("・");
  const lines = [
    `### ${number} ${name}（${profile}）`,
    `父 ${stringField(entry, "sire_name") ?? "—"} / 母父 ${stringField(entry, "broodmare_sire_name") ?? "—"}`,
    `今回単勝 ${numberField(entry, "win_odds") ?? "—"} / 今回人気 ${numberField(entry, "win_odds_rank") ?? "—"}`,
  ];
  const abnormality = stringField(entry, "race_abnormality");
  if (abnormality && SCRATCHED.has(abnormality)) {
    lines.push(abnormality);
    return lines.join("\n");
  }
  if (!task) {
    lines.push("近走: 未取得");
    return lines.join("\n");
  }
  if (task.note) lines.push(task.note);
  if (task.rows.length === 0) lines.push("近走なし");
  else lines.push(...task.rows.map((row) => formatPastRun(row)));
  return lines.join("\n");
}

function placeLabel(row: Record<string, unknown>): string {
  const abnormality = stringField(row, "race_abnormality");
  if (abnormality) return abnormality;
  const place = numberField(row, "official_result");
  const text = place == null ? "着順—" : `${trimNum(place)}着`;
  const extra = [stringField(row, "entry_status") === "provisional" ? "速報" : null, row.dead_heat === true ? "同着" : null]
    .filter((part): part is string => Boolean(part))
    .join("・");
  return extra ? `${text}（${extra}）` : text;
}

function courseLabel(row: Record<string, unknown>): string {
  const track = stringField(row, "race_track") ?? "場不明";
  const surface = stringField(row, "surface") ?? "";
  const distance = numberField(row, "distance");
  const rail = stringField(row, "rail_type");
  return `${track}${surface}${distance == null ? "" : `${trimNum(distance)}m`}${rail ? `（${rail}）` : ""}`;
}

function classLabel(row: Record<string, unknown>): string {
  const grade = stringField(row, "grade");
  const parts = [grade && grade !== "平場" ? grade : null, stringField(row, "race_condition"), stringField(row, "race_name_main")].filter(
    (part): part is string => Boolean(part),
  );
  return parts.join(" ") || "クラス不明";
}

function passing(row: Record<string, unknown>): string {
  const corners = ["first_corner_position", "second_corner_position", "third_corner_position", "fourth_corner_position"].map((key) => {
    const value = numberField(row, key);
    return value == null ? "—" : trimNum(value);
  });
  return corners.every((corner) => corner === "—") ? "—" : corners.join("-");
}

function formatTime(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${trimNum(sec)}秒`;
  const minutes = Math.floor(sec / 60);
  const rest = (sec - minutes * 60).toFixed(1);
  return `${minutes}:${rest.padStart(4, "0")}`;
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
