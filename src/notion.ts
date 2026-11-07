import { budgetedFetch, ExternalBudget } from "./budget";
import { BASHIRA_MARKER, JobError, type RaceRef } from "./types";

export interface NotionSchema {
  properties: Record<string, { type?: string; select?: { options?: Array<{ name?: string }> } }>;
}

export interface NotionPageRef {
  id: string;
  matchesRace: boolean;
  isBashira: boolean;
}

const EXPECTED: Record<string, string> = {
  名前: "title",
  日付: "date",
  競馬場: "select",
  レース: "select",
  指数分布: "rich_text",
  自信度: "rich_text",
  波乱度: "rich_text",
};

export function assertDatabaseSchema(schema: NotionSchema): { venues: Set<string>; races: Set<string> } {
  const properties = schema.properties ?? {};
  for (const [name, type] of Object.entries(EXPECTED)) {
    const actual = properties[name]?.type;
    if (actual !== type) {
      throw new JobError(
        `Notion の「${name}」は ${type} である必要があります（実際: ${actual ?? "なし"}）。スキーマは変更しません`,
        false,
      );
    }
  }
  const venues = new Set((properties["競馬場"]?.select?.options ?? []).map((option) => option.name).filter((name): name is string => Boolean(name)));
  const races = new Set((properties["レース"]?.select?.options ?? []).map((option) => option.name).filter((name): name is string => Boolean(name)));
  return { venues, races };
}

export function assertSelectValues(race: RaceRef, options: { venues: Set<string>; races: Set<string> }): void {
  if (!options.venues.has(race.venue)) {
    throw new JobError(`競馬場「${race.venue}」は既存の選択肢にありません。新しい選択肢は作りません`, false);
  }
  const raceName = String(race.raceNumber);
  if (!options.races.has(raceName)) {
    throw new JobError(`レース「${raceName}」は既存の選択肢にありません。新しい選択肢は作りません`, false);
  }
}

export interface NotionDecisionInput {
  stored: { id: string; found: boolean; matchesRace: boolean } | null;
  pages: Array<{ id: string; isBashira: boolean }>;
  truncated: boolean;
  /** この実行で作成済みのページ。旧ページが残っていてもこれを使い、重複では止めない。 */
  resumePageId?: string | null;
}

export type NotionDecision =
  | { action: "create" }
  | { action: "update"; pageId: string }
  | { action: "resume"; pageId: string }
  | { action: "error"; message: string };

/**
 * Dify のページ（本文のどこにも BASHIRAで取得 が無いもの）は候補にしない。
 * 引き継ぐページ ID が無いときに BASHIRA ページが複数ならエラー。
 * resumePageId は作成直後に保存したページなので、旧ページが残っていてもそれを使う。
 */
export function decideNotionTarget(input: NotionDecisionInput): NotionDecision {
  if (input.resumePageId) {
    const storedIsResume = input.stored?.id === input.resumePageId;
    if (storedIsResume && input.stored?.found && !input.stored.matchesRace) {
      return {
        action: "error",
        message: "KV の Notion ページは日付・競馬場・レースが一致しません。別ページを推測しないので止めます",
      };
    }
    // 保存したページが 404 のときだけ、通常の判断に戻す。
    if (!(storedIsResume && input.stored && !input.stored.found)) {
      return { action: "resume", pageId: input.resumePageId };
    }
  }
  if (input.truncated) {
    return { action: "error", message: "同じレースの Notion 検索が打ち切られました。どれが BASHIRA のページか判断できないので止めます" };
  }
  const bashira = input.pages.filter((page) => page.isBashira);
  if (input.stored?.found) {
    if (!input.stored.matchesRace) {
      return { action: "error", message: "KV の Notion ページは日付・競馬場・レースが一致しません。別ページを推測しないので止めます" };
    }
    const others = bashira.filter((page) => page.id !== input.stored?.id);
    if (others.length > 0) {
      return { action: "error", message: "このレースの BASHIRA ページが複数あります。どれを更新するか判断できないので止めます" };
    }
    return { action: "update", pageId: input.stored.id };
  }
  if (bashira.length > 1) {
    return { action: "error", message: "このレースの BASHIRA ページが複数あります。どれを更新するか判断できないので止めます" };
  }
  if (bashira.length === 1) return { action: "update", pageId: bashira[0]!.id };
  return { action: "create" };
}

export function pageMatchesRace(page: unknown, race: RaceRef): boolean {
  if (!page || typeof page !== "object") return false;
  const properties = (page as { properties?: Record<string, unknown> }).properties ?? {};
  const date = readDate(properties["日付"]);
  const venue = readSelect(properties["競馬場"]);
  const raceNumber = readSelect(properties["レース"]);
  return date === race.date && venue === race.venue && raceNumber === String(race.raceNumber);
}

export function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { plain_text?: unknown; text?: { content?: unknown } }).plain_text;
      if (typeof text === "string") return text;
      const content = (part as { text?: { content?: unknown } }).text?.content;
      return typeof content === "string" ? content : "";
    })
    .join("");
}

/** 取得済みブロックのどこかに BASHIRAで取得 があるか。先頭行ではなく末尾の灰色フッターも見る。 */
export function blocksIncludeBashira(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    const type = record.type;
    const body = typeof type === "string" ? record[type] : undefined;
    if (!body || typeof body !== "object") continue;
    const text = plainText((body as { rich_text?: unknown }).rich_text);
    if (text.includes(BASHIRA_MARKER)) return true;
  }
  return false;
}

export function notionProperties(input: {
  title: string;
  race: RaceRef;
  指数分布: string;
  自信度: string;
  波乱度: string;
}): Record<string, unknown> {
  return {
    名前: { title: [{ type: "text", text: { content: clip(input.title, 200) } }] },
    日付: { date: { start: input.race.date } },
    競馬場: { select: { name: input.race.venue } },
    レース: { select: { name: String(input.race.raceNumber) } },
    指数分布: { rich_text: rich(input.指数分布) },
    自信度: { rich_text: rich(input.自信度) },
    波乱度: { rich_text: rich(input.波乱度) },
  };
}

export function paragraphBlocks(lines: string[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const chunks = splitText(line, 1800);
    for (const chunk of chunks.length > 0 ? chunks : [""]) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
      });
    }
  }
  return blocks;
}

export async function notionFetch(
  budget: ExternalBudget,
  token: string,
  path: string,
  init?: RequestInit,
  fetcher?: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const response = await budgetedFetch(
    budget,
    `https://api.notion.com/v1${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": "2022-06-28",
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    },
    fetcher,
  );
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function rich(value: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: { content: clip(value, 2000) } }];
}

function clip(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  return `${chars.slice(0, max - 1).join("")}…`;
}

function splitText(value: string, size: number): string[] {
  const chars = [...value];
  if (chars.length === 0) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += size) chunks.push(chars.slice(index, index + size).join(""));
  return chunks;
}

function readDate(property: unknown): string | null {
  if (!property || typeof property !== "object") return null;
  const start = (property as { date?: { start?: unknown } }).date?.start;
  return typeof start === "string" ? start.slice(0, 10) : null;
}

function readSelect(property: unknown): string | null {
  if (!property || typeof property !== "object") return null;
  const name = (property as { select?: { name?: unknown } }).select?.name;
  return typeof name === "string" ? name : null;
}
