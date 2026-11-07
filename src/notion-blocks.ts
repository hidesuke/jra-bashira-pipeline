/**
 * Dify「Notion用にに出力整形」と同じ規則で Markdown を Notion ブロックにする。
 * 見出しは #### / ### / ## / # の順。箇条書きは `- ` と `* `。
 * 区切りは --- / *** / ___。``` は code。**太字** は annotations.bold。
 * 各 rich_text は 2000 文字まで。Dify のコードは超過分を切るが、ここでは
 * 同じ装飾の続きとして残す（長いコース分析を落とさない）。
 * 追加リクエストは 100 ブロックずつ（Dify の chunk_size）。
 */

const TEXT_LIMIT = 2000;

export const NOTION_CHILD_CHUNK = 100;

export function chunkChildren<T>(blocks: T[], size = NOTION_CHILD_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < blocks.length; index += size) chunks.push(blocks.slice(index, index + size));
  return chunks;
}

export function splitChars(text: string, size = TEXT_LIMIT): string[] {
  const chars = [...text];
  if (chars.length === 0) return [];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += size) chunks.push(chars.slice(index, index + size).join(""));
  return chunks;
}

export function parseRichText(text: string, annotations?: Record<string, boolean | string>): Array<Record<string, unknown>> {
  const rich: Array<Record<string, unknown>> = [];
  for (const part of text.split(/(\*\*.*?\*\*)/)) {
    if (!part) continue;
    const bold = part.startsWith("**") && part.endsWith("**");
    const content = bold ? part.slice(2, -2) : part;
    if (!content) continue;
    const marks = bold ? { bold: true, ...annotations } : annotations;
    for (const chunk of splitChars(content)) {
      const item: Record<string, unknown> = { type: "text", text: { content: chunk } };
      if (marks && Object.keys(marks).length > 0) item.annotations = marks;
      rich.push(item);
    }
  }
  return rich.length > 0 ? rich : [{ type: "text", text: { content: "" } }];
}

export function markdownToNotionBlocks(rawInput: string): Array<Record<string, unknown>> {
  const lines = rawInput.split("\n");
  const children: Array<Record<string, unknown>> = [];
  let inCode = false;
  let language = "plain text";
  let codeLines: string[] = [];

  const pushCode = () => {
    const content = codeLines.join("\n");
    const pieces = splitChars(content);
    for (const piece of pieces.length > 0 ? pieces : [""]) {
      children.push({
        object: "block",
        type: "code",
        code: {
          caption: [],
          rich_text: [{ type: "text", text: { content: piece } }],
          language,
        },
      });
    }
  };

  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        const lang = stripped.slice(3).trim().toLowerCase();
        language = lang || "plain text";
        codeLines = [];
        continue;
      }
      inCode = false;
      pushCode();
      codeLines = [];
      continue;
    }
    if (inCode) {
      codeLines.push(line.replace(/\r$/, ""));
      continue;
    }
    if (!stripped) continue;
    if (stripped === "---" || stripped === "***" || stripped === "___") {
      children.push(dividerBlock());
      continue;
    }
    const heading = headingOf(stripped);
    if (heading) {
      children.push({
        object: "block",
        type: heading.type,
        [heading.type]: { rich_text: parseRichText(heading.content) },
      });
      continue;
    }
    if (stripped.startsWith("* ") || stripped.startsWith("- ")) {
      children.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: parseRichText(stripped.slice(2).trim()) },
      });
      continue;
    }
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: parseRichText(stripped) },
    });
  }
  return children;
}

export function dividerBlock(): Record<string, unknown> {
  return { object: "block", type: "divider", divider: {} };
}

export function grayParagraph(text: string): Record<string, unknown> {
  const pieces = splitChars(text);
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: (pieces.length > 0 ? pieces : [""]).map((content) => ({
        type: "text",
        text: { content },
        annotations: { color: "gray" },
      })),
      color: "gray",
    },
  };
}

function headingOf(stripped: string): { type: string; content: string } | null {
  if (stripped.startsWith("#### ")) return { type: "heading_4", content: stripped.slice(5).trim() };
  if (stripped.startsWith("### ")) return { type: "heading_3", content: stripped.slice(4).trim() };
  if (stripped.startsWith("## ")) return { type: "heading_2", content: stripped.slice(3).trim() };
  if (stripped.startsWith("# ")) return { type: "heading_1", content: stripped.slice(2).trim() };
  return null;
}
