export interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

/** MCP のセッション ID は任意。無いときは後続リクエストにも付けない。 */
export interface McpSession {
  id: string | null;
  protocol: string;
}

export class McpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "McpStatusError";
  }
}

const MCP_PROTOCOLS = ["2025-06-18", "2025-03-26"] as const;

export function readMcpSessionId(header: string | null): string | null {
  const value = header?.trim() ?? "";
  return value === "" ? null : value;
}

export function mcpJsonHeaders(token: string, session: McpSession | null): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (!session) return headers;
  headers["mcp-protocol-version"] = session.protocol;
  if (session.id) headers["mcp-session-id"] = session.id;
  return headers;
}

type McpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function initializeMcpSession(input: {
  url: string;
  token: string;
  fetchImpl: McpFetch;
  nextId: () => number;
  clientInfo: { name: string; version: string };
}): Promise<{ session: McpSession; result: unknown }> {
  let last: unknown;
  for (const protocol of MCP_PROTOCOLS) {
    const response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: mcpJsonHeaders(input.token, null),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: input.nextId(),
        method: "initialize",
        params: {
          protocolVersion: protocol,
          capabilities: {},
          clientInfo: input.clientInfo,
        },
      }),
    });
    if (response.status === 401) throw new McpStatusError(401, "MCP initialize が 401 を返しました");
    const text = await response.text();
    if (!response.ok) {
      last = new Error(`MCP initialize HTTP ${response.status}: ${text.slice(0, 300)}`);
      continue;
    }
    let message: JsonRpcMessage;
    try {
      message = parseMcpHttpBody(response.headers.get("content-type") ?? "", text);
    } catch (err) {
      last = err;
      continue;
    }
    if (message.error) {
      last = new Error(message.error.message ?? "MCP initialize に失敗しました");
      continue;
    }
    const session: McpSession = {
      id: readMcpSessionId(response.headers.get("mcp-session-id")),
      protocol,
    };
    await postMcp({
      url: input.url,
      token: input.token,
      session,
      fetchImpl: input.fetchImpl,
      notification: true,
      body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    });
    return { session, result: message.result };
  }
  throw last instanceof Error ? last : new Error("MCP initialize に失敗しました");
}

export async function postMcp(input: {
  url: string;
  token: string;
  session: McpSession;
  fetchImpl: McpFetch;
  body: unknown;
  notification?: boolean;
}): Promise<{ result: unknown }> {
  const response = await input.fetchImpl(input.url, {
    method: "POST",
    headers: mcpJsonHeaders(input.token, input.session),
    body: JSON.stringify(input.body),
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 404) {
    throw new McpStatusError(response.status, text.slice(0, 300));
  }
  if (input.notification && (response.status === 202 || response.ok || text.trim() === "")) {
    return { result: null };
  }
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 400)}`);
  if (!text.trim()) return { result: null };
  const message = parseMcpHttpBody(response.headers.get("content-type") ?? "", text);
  if (message.error) throw new Error(message.error.message ?? "MCP が失敗しました");
  return { result: message.result };
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
