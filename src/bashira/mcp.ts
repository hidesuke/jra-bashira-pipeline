export interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export function parseMcpHttpBody(contentType: string, text: string): JsonRpcMessage {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("MCP の応答ボディが空です");
  if (contentType.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const data = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    for (let index = data.length - 1; index >= 0; index -= 1) {
      const parsed = JSON.parse(data[index]!) as JsonRpcMessage;
      if (parsed.result !== undefined || parsed.error || parsed.id !== undefined) return parsed;
    }
    throw new Error("MCP SSE に JSON-RPC 応答がありません");
  }
  return JSON.parse(trimmed) as JsonRpcMessage;
}

export function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  const text = (record.content ?? []).find((part) => part.type === "text" && typeof part.text === "string")?.text;
  if (record.isError) {
    throw new Error(text || "MCP tool が isError を返しました");
  }
  if (text == null) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** 名前が複数候補のまま絞れていない応答。実レスポンスの形は未確認なので、明示的な候補配列だけを見る。 */
export function ambiguousNameMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const resolution = (payload as { name_resolution?: unknown }).name_resolution;
  if (!resolution || typeof resolution !== "object") return null;
  const entries = Array.isArray(resolution) ? resolution : Object.values(resolution);
  const problems: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      candidates?: unknown;
      matches?: unknown;
      resolved?: unknown;
      selected?: unknown;
      ambiguous?: unknown;
    };
    if (record.ambiguous === false || record.resolved || record.selected) continue;
    const candidates = Array.isArray(record.candidates)
      ? record.candidates
      : Array.isArray(record.matches)
        ? record.matches
        : null;
    if (record.ambiguous === true || (candidates && candidates.length > 1)) {
      const names = (candidates ?? []).slice(0, 5).map((candidate) => {
        if (candidate && typeof candidate === "object" && "name" in candidate) {
          return String((candidate as { name: unknown }).name);
        }
        return typeof candidate === "string" ? candidate : JSON.stringify(candidate);
      });
      problems.push(names.join(" / ") || "候補あり");
    }
  }
  if (problems.length === 0) return null;
  return `BASHIRA の名前解決が曖昧です: ${problems.join(" ; ")}。候補を決め打ちしないので止めます`;
}
