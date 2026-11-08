/**
 * 買い目見出しの点数を、馬番の列から数え直す。
 * フォーメーション、ボックス、流しの列を読み、同じ馬が重なる組と、同じ組の重複を除く。
 * 見出しの点数と違うときだけ、その数字を差し替える。列が読めない見出しは元のまま。
 */

export interface TicketCountCorrection {
  /** 券種。複数あるときは「馬連・馬単」。 */
  tickets: string;
  declared: number;
  counted: number;
}

interface Ticket {
  name: string;
  /** 1組に必要な頭数。 */
  k: number;
  /** 着順どおりに数える券種（馬単・3連単など）。 */
  ordered: boolean;
}

interface Declaration {
  tickets: Ticket[];
  declared: number;
  mode: "box" | "nagashi" | "formation" | "conflict" | null;
  multi: boolean;
  place: 1 | 2 | 3 | null;
}

interface Label {
  kind: "pos" | "axis" | "opponent";
  index: number | null;
  horses: number[];
}

interface ParsedBody {
  labels: Label[];
  formations: number[][][];
  lists: number[][];
}

const TICKET_DEFS: Array<{ pattern: string; name: string; k: number; ordered: boolean }> = [
  { pattern: "3連単", name: "3連単", k: 3, ordered: true },
  { pattern: "三連単", name: "3連単", k: 3, ordered: true },
  { pattern: "3連複", name: "3連複", k: 3, ordered: false },
  { pattern: "三連複", name: "3連複", k: 3, ordered: false },
  { pattern: "2連単", name: "2連単", k: 2, ordered: true },
  { pattern: "二連単", name: "2連単", k: 2, ordered: true },
  { pattern: "2連複", name: "2連複", k: 2, ordered: false },
  { pattern: "二連複", name: "2連複", k: 2, ordered: false },
  { pattern: "馬単", name: "馬単", k: 2, ordered: true },
  { pattern: "馬連", name: "馬連", k: 2, ordered: false },
  { pattern: "ワイド", name: "ワイド", k: 2, ordered: false },
  { pattern: "枠連", name: "枠連", k: 2, ordered: false },
  { pattern: "単勝", name: "単勝", k: 1, ordered: false },
  { pattern: "複勝", name: "複勝", k: 1, ordered: false },
];

const POINT = /[（(]\s*(\d+)\s*点\s*[）)]/;
const LABEL = /^(1頭目|2頭目|3頭目|1列目|2列目|3列目|1着|2着|3着|軸馬|軸|相手馬|相手|ヒモ|ひも)\s*[:：]\s*(.+)$/;
const POSITION: Record<string, number> = {
  "1頭目": 0,
  "2頭目": 1,
  "3頭目": 2,
  "1列目": 0,
  "2列目": 1,
  "3列目": 2,
  "1着": 0,
  "2着": 1,
  "3着": 2,
};

export function correctTicketCounts(text: string): { text: string; corrections: TicketCountCorrection[] } {
  const lines = text.split("\n");
  const corrections: TicketCountCorrection[] = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    try {
      const decl = parseDeclaration(raw);
      if (!decl) continue;
      const body = collectBody(lines, i + 1);
      const counted = countDeclaration(decl, body);
      if (counted == null || counted === decl.declared) continue;
      const replaced = replacePoint(raw, decl.declared, counted);
      if (replaced == null) continue;
      lines[i] = replaced;
      corrections.push({
        tickets: decl.tickets.map((ticket) => ticket.name).join("・"),
        declared: decl.declared,
        counted,
      });
    } catch {
      // この見出しは読めなくても、ほかの買い目とジョブは続ける。
    }
  }
  return { text: lines.join("\n"), corrections };
}

function collectBody(lines: string[], start: number): string[] {
  const body: string[] = [];
  for (let j = start; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (line.trim().startsWith("```")) break;
    if (normalize(line).trim() === "") continue;
    if (parseDeclaration(line) || isBreak(line) || !isHorseLine(line)) break;
    body.push(line);
  }
  return body;
}

function countDeclaration(decl: Declaration, body: string[]): number | null {
  if (decl.mode === "conflict" || body.length === 0) return null;
  const parsed = classifyBody(body);
  if (!parsed) return null;
  return countParsed(decl, parsed);
}

function countParsed(decl: Declaration, parsed: ParsedBody): number | null {
  if (decl.mode === "box") {
    if (parsed.labels.some((label) => label.kind === "pos")) return null;
    const horses = [
      ...parsed.labels.flatMap((label) => label.horses),
      ...parsed.formations.flat(2),
      ...parsed.lists.flat(),
    ];
    if (horses.length === 0) return null;
    return sumTickets(decl.tickets, (ticket) => boxCount(ticket, horses));
  }

  if (parsed.labels.some((label) => label.kind === "pos")) {
    const formed = sumTickets(decl.tickets, (ticket) => {
      const columns = columnsFromPositions(parsed.labels, ticket.k);
      if (!columns) return null;
      return comboCount([columns], ticket, decl.multi);
    });
    if (formed != null) return formed;
    return sumTickets(decl.tickets, (ticket) => singlePlaceNagashi(parsed.labels, ticket, decl.multi, decl.place));
  }

  const axes = parsed.labels.filter((label) => label.kind === "axis").flatMap((label) => label.horses);
  const opponents = parsed.labels.filter((label) => label.kind === "opponent").flatMap((label) => label.horses);
  if (axes.length > 0 && opponents.length > 0) {
    const nagashi = sumTickets(decl.tickets, (ticket) => nagashiCount(ticket, axes, opponents, decl.multi, decl.place));
    if (nagashi != null) return nagashi;
  }

  if (parsed.formations.length > 0) {
    return sumTickets(decl.tickets, (ticket) => formationLinesCount(ticket, parsed.formations, decl));
  }
  if (parsed.lists.length > 0 && decl.mode !== "nagashi") {
    return sumTickets(decl.tickets, (ticket) => listCount(ticket, parsed.lists));
  }
  return null;
}

function columnsFromPositions(labels: Label[], k: number): number[][] | null {
  const columns: number[][] = Array.from({ length: k }, () => []);
  const opponents: number[] = [];
  let seen = false;
  for (const label of labels) {
    if (label.kind === "pos" && label.index != null) {
      if (label.index >= k) return null;
      seen = true;
      columns[label.index]?.push(...label.horses);
    } else if (label.kind === "opponent") {
      opponents.push(...label.horses);
    }
  }
  if (!seen) return null;
  const missing = columns.flatMap((column, index) => (column.length === 0 ? [index] : []));
  if (missing.length === 1 && opponents.length > 0) columns[missing[0] ?? -1]?.push(...opponents);
  if (columns.some((column) => column.length === 0)) return null;
  return columns;
}

function singlePlaceNagashi(labels: Label[], ticket: Ticket, multi: boolean, headingPlace: 1 | 2 | 3 | null): number | null {
  const positions = labels.filter((label) => label.kind === "pos");
  const opponents = labels.filter((label) => label.kind === "opponent").flatMap((label) => label.horses);
  const index = positions[0]?.index;
  if (index == null || opponents.length === 0 || positions.some((label) => label.index !== index)) return null;
  const place = (index + 1) as 1 | 2 | 3;
  if (headingPlace != null && headingPlace !== place) return null;
  return nagashiCount(ticket, positions.flatMap((label) => label.horses), opponents, multi, place);
}

function formationLinesCount(ticket: Ticket, lines: number[][][], decl: Declaration): number | null {
  if (lines.every((columns) => columns.length === ticket.k)) return comboCount(lines, ticket, decl.multi);
  const first = lines[0];
  if (decl.mode === "nagashi" && lines.length === 1 && first?.length === 2 && ticket.k === 3) {
    return nagashiCount(ticket, first[0] ?? [], first[1] ?? [], decl.multi, decl.place);
  }
  return null;
}

function comboCount(lines: number[][][], ticket: Ticket, multi: boolean): number | null {
  if (multi && ticket.ordered && ticket.k > 2) return null;
  const seen = new Set<string>();
  const bothWays = multi && ticket.ordered && ticket.k === 2;
  for (const columns of lines) {
    const cols = columns.map((column) => [...new Set(column)]);
    if (cols.some((column) => column.length === 0)) return null;
    walk(cols, ticket.ordered, bothWays, seen, []);
  }
  return seen.size > 0 ? seen.size : null;
}

function walk(cols: number[][], ordered: boolean, bothWays: boolean, seen: Set<string>, chosen: number[]): void {
  if (chosen.length === cols.length) {
    if (!ordered) {
      seen.add([...chosen].sort((a, b) => a - b).join("-"));
      return;
    }
    seen.add(chosen.join("-"));
    if (bothWays) seen.add([...chosen].reverse().join("-"));
    return;
  }
  const column = cols[chosen.length];
  if (!column) return;
  for (const horse of column) {
    if (chosen.includes(horse)) continue;
    chosen.push(horse);
    walk(cols, ordered, bothWays, seen, chosen);
    chosen.pop();
  }
}

function boxCount(ticket: Ticket, horses: number[]): number | null {
  const unique = [...new Set(horses)];
  if (unique.length < ticket.k) return null;
  return ticket.ordered ? perm(unique.length, ticket.k) : comb(unique.length, ticket.k);
}

function listCount(ticket: Ticket, lists: number[][]): number | null {
  if (ticket.k === 1) {
    const horses = [...new Set(lists.flat())];
    return horses.length > 0 ? horses.length : null;
  }
  const seen = new Set<string>();
  for (const list of lists) {
    const unique = [...new Set(list)];
    if (unique.length !== ticket.k) return null;
    const key = ticket.ordered ? unique.join("-") : [...unique].sort((a, b) => a - b).join("-");
    seen.add(key);
  }
  return seen.size > 0 ? seen.size : null;
}

function nagashiCount(
  ticket: Ticket,
  axes: number[],
  opponents: number[],
  multi: boolean,
  place: 1 | 2 | 3 | null,
): number | null {
  const axis = [...new Set(axes)];
  const opp = [...new Set(opponents)].filter((horse) => !axis.includes(horse));
  const need = ticket.k - axis.length;
  if (axis.length === 0 || need <= 0 || opp.length < need) return null;
  if (!ticket.ordered) return comb(opp.length, need);
  if (multi) {
    if (axis.length === 1) return ticket.k * perm(opp.length, need);
    if (axis.length === 2 && ticket.k === 3) return opp.length * 6;
    return null;
  }
  if (axis.length === 1 && place != null) return perm(opp.length, need);
  return null;
}

function sumTickets(tickets: Ticket[], countOne: (ticket: Ticket) => number | null): number | null {
  let total = 0;
  for (const ticket of tickets) {
    const count = countOne(ticket);
    if (count == null || count < 1) return null;
    total += count;
  }
  return total;
}

function classifyBody(lines: string[]): ParsedBody | null {
  const labels: Label[] = [];
  const formations: number[][][] = [];
  const lists: number[][] = [];
  for (const raw of lines) {
    const text = stripDecor(raw);
    const label = parseLabel(text);
    if (label) {
      labels.push(label);
      continue;
    }
    const formation = parseFormationLine(text);
    if (formation) {
      formations.push(formation);
      continue;
    }
    const list = parseHorseList(stripNotes(text));
    if (list) {
      lists.push(list);
      continue;
    }
    return null;
  }
  return { labels, formations, lists };
}

function parseDeclaration(line: string): Declaration | null {
  const normalized = normalize(line);
  const match = POINT.exec(normalized);
  const digits = match?.[1];
  if (!match || digits == null) return null;
  const tickets = findTickets(normalized.slice(0, match.index));
  if (tickets.length === 0) return null;
  const declared = Number(digits);
  if (!Number.isInteger(declared) || declared < 0) return null;
  return {
    tickets,
    declared,
    mode: readMode(normalized),
    multi: normalized.includes("マルチ"),
    place: readPlace(normalized),
  };
}

function findTickets(text: string): Ticket[] {
  const found: Ticket[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < text.length; index++) {
    const hit = TICKET_DEFS.find((ticket) => text.startsWith(ticket.pattern, index));
    if (!hit) continue;
    if (!seen.has(hit.name)) {
      seen.add(hit.name);
      found.push({ name: hit.name, k: hit.k, ordered: hit.ordered });
    }
    index += hit.pattern.length - 1;
  }
  return found;
}

function readMode(text: string): Declaration["mode"] {
  const box = text.includes("ボックス") || /BOX/i.test(text);
  const nagashi = text.includes("流し") || text.includes("ながし");
  const formation = text.includes("フォーメーション");
  const picked = Number(box) + Number(nagashi) + Number(formation);
  if (picked > 1) return "conflict";
  if (box) return "box";
  if (nagashi) return "nagashi";
  if (formation) return "formation";
  return null;
}

function readPlace(text: string): 1 | 2 | 3 | null {
  const hits = [...text.matchAll(/(?<![0-9])([123])着/g)].map((match) => Number(match[1]));
  const unique = [...new Set(hits)];
  if (unique.length !== 1) return null;
  const place = unique[0];
  if (place === 1 || place === 2 || place === 3) return place;
  return null;
}

function parseLabel(text: string): Label | null {
  const match = LABEL.exec(text);
  const name = match?.[1];
  const value = match?.[2];
  if (!name || value == null) return null;
  const horses = parseHorseList(stripNotes(value));
  if (!horses) return null;
  if (name === "軸" || name === "軸馬") return { kind: "axis", index: null, horses };
  if (name === "相手" || name === "相手馬" || name === "ヒモ" || name === "ひも") return { kind: "opponent", index: null, horses };
  const index = POSITION[name];
  if (index == null) return null;
  return { kind: "pos", index, horses };
}

function parseFormationLine(text: string): number[][] | null {
  const cleaned = stripNotes(text).trim();
  if (!cleaned) return null;
  let parts: string[];
  if (/→|⇒|->|➡/.test(cleaned)) parts = cleaned.split(/\s*(?:→|⇒|->|➡)\s*/);
  else if (/[-−–—－]/.test(cleaned)) parts = cleaned.split(/\s*[-−–—－]\s*/);
  else return null;
  if (parts.length < 2) return null;
  const columns: number[][] = [];
  for (const part of parts) {
    const horses = parseHorseList(part);
    if (!horses) return null;
    columns.push(horses);
  }
  return columns;
}

function parseHorseList(text: string): number[] | null {
  const cleaned = text.trim();
  if (!cleaned || !/^[\d\s,、・]+$/.test(cleaned)) return null;
  const nums = cleaned.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  const horses = nums.map(Number);
  if (horses.some((horse) => horse < 1 || horse > 18)) return null;
  return horses;
}

function isHorseLine(line: string): boolean {
  const text = stripDecor(line);
  if (!text) return false;
  return parseLabel(text) != null || parseFormationLine(text) != null || parseHorseList(stripNotes(text)) != null;
}

function isBreak(line: string): boolean {
  const text = normalize(line).trim();
  return /^#{1,6}\s/.test(text) || text === "---" || text === "***" || text === "___";
}

function replacePoint(line: string, declared: number, counted: number): string | null {
  const match = /[（(]\s*[0-9０-９]+\s*点\s*[）)]/.exec(line);
  if (!match) return null;
  const digits = /[0-9０-９]+/.exec(match[0]);
  if (!digits || digits.index == null) return null;
  const value = Number(digits[0].replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30)));
  if (value !== declared) return null;
  const start = match.index + digits.index;
  return line.slice(0, start) + String(counted) + line.slice(start + digits[0].length);
}

function stripDecor(line: string): string {
  return normalize(line)
    .trim()
    .replace(/^[-*・]\s+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function stripNotes(text: string): string {
  return text.replace(/(?:\s*[（(][^）)]*[）)])+\s*$/g, "").trim();
}

function normalize(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/\u3000/g, " ");
}

function comb(n: number, k: number): number {
  if (k < 0 || n < k) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

function perm(n: number, k: number): number {
  if (k < 0 || n < k) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result *= n - i;
  return result;
}
