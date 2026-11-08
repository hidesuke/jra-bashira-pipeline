import { BASHIRA_MARKER, type RaceRef } from "./types";
import type { OddsSummary } from "./odds";
import { dividerBlock, grayParagraph, markdownToNotionBlocks } from "./notion-blocks";
import { stripRelatedCourses } from "./related-courses";

export interface PageBodyInput {
  race: RaceRef;
  raceName: string | null;
  requestedBy: string;
  odds: OddsSummary;
  courseModel: string;
  raceModel: string;
  courseModelVersion: string | null;
  raceModelVersion: string | null;
  coursePromptVersion: string;
  racePromptVersion: string;
  印: string;
  予想本文: string;
  courseText: string;
}

/** G1 / G2 / G3 / L / OP だけ括弧で足す。平場・その他重賞・空は付けない。 */
const GRADE_LABEL = /^(G[1-3]|L|OP)$/;

/**
 * Dify のパラメータ抽出はタイトルを「レース名」として取る。
 * BASHIRA の race_name_main にグレードは含まれないので、あるときだけ
 * `アルゼンチン共和国杯（G2）` のように全角括弧で足す。
 */
export function pageTitle(race: RaceRef, raceName: string | null, grade?: string | null): string {
  const base = raceName?.trim() || `${race.venue}${race.raceNumber}R`;
  const label = gradeLabel(grade);
  if (!label) return base;
  if (base.includes(`（${label}）`) || base.includes(`(${label})`)) return base;
  return `${base}（${label}）`;
}

export function pageBlocks(input: PageBodyInput): Array<Record<string, unknown>> {
  const blocks = markdownToNotionBlocks(pageMarkdown(input));
  blocks.push(dividerBlock());
  for (const line of footerLines(input)) blocks.push(grayParagraph(line));
  return blocks;
}

/**
 * 予想本文の見出し順はモデルの出力のまま。
 * Worker が足すのは、本文に無い印と、コース分析だけ。
 * コース分析は `### 指数ランキングと短評` の直前に置く。その見出しが無いときは末尾。
 * 単勝オッズの節は出さない。倍率はフッターの観測と、レース予想の `{{win_odds}}` に残す。
 */
export function pageMarkdown(input: PageBodyInput): string {
  let body = input.予想本文.trim();
  const mark = input.印.trim();
  if (mark && !body.includes("競馬新聞風印予想")) {
    const bullets = mark
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => (line.startsWith("- ") || line.startsWith("* ") ? line : `- ${line}`));
    const section = ["### 競馬新聞風印予想", ...bullets].join("\n");
    body = body ? `${body}\n\n${section}` : section;
  }
  const course = clipAnalysis(stripRelatedCourses(input.courseText).text).trim();
  if (course && !body.includes(course.slice(0, 80))) body = placeCourseAnalysis(body, course);
  return body;
}

const RANKING_HEADING = "### 指数ランキングと短評";

function placeCourseAnalysis(body: string, course: string): string {
  const section = `### コース分析\n${course}`;
  const lines = body.split("\n");
  const index = lines.findIndex((line) => line.trim() === RANKING_HEADING);
  if (index < 0) return body ? `${body}\n\n${section}` : section;
  const before = lines.slice(0, index).join("\n").trimEnd();
  const after = lines.slice(index).join("\n").trimStart();
  return [before, section, after].filter((part) => part !== "").join("\n\n");
}

export function footerLines(input: PageBodyInput): string[] {
  const oddsReason = input.odds.available ? "あり" : `なし（${input.odds.reason ?? "理由不明"}）`;
  const heading = `${input.race.date} ${input.race.venue} ${input.race.raceNumber}R ${input.raceName ?? ""}`.trim();
  const lines = [
    `${BASHIRA_MARKER}　${heading}　実行者: ${input.requestedBy}　course_variant: null（内・外コースのデータは無い）`,
    `オッズ種別: ${input.odds.kind ?? "なし"}　オッズ観測時刻（JST）: ${input.odds.observedAtJst ?? "なし"}　オッズ: ${oddsReason}`,
    `指定モデル（course）: ${input.courseModel}　指定モデル（race）: ${input.raceModel}`,
    `応答モデル modelVersion（course）: ${input.courseModelVersion ?? "応答に modelVersion が無い"}　応答モデル modelVersion（race）: ${input.raceModelVersion ?? "応答に modelVersion が無い"}`,
    `プロンプト版（course）: ${input.coursePromptVersion}　プロンプト版（race）: ${input.racePromptVersion}`,
  ];
  if (input.odds.detail) lines.push(`オッズ詳細: ${input.odds.detail}`);
  return lines;
}

function gradeLabel(grade: string | null | undefined): string | null {
  const value = grade?.trim() ?? "";
  if (!value || value === "平場" || value === "その他重賞") return null;
  return GRADE_LABEL.test(value) ? value : null;
}

function clipAnalysis(text: string): string {
  const chars = [...text];
  if (chars.length <= 8000) return text;
  return `${chars.slice(0, 8000).join("")}\n…（コース分析を省略）`;
}
