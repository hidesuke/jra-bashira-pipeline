import { describe, expect, it } from "vitest";
import { initializeMcpSession, postMcp, readMcpSessionId, unwrapToolResult } from "../src/bashira/mcp";

const url = "https://mcp.bashira.example/mcp";
const token = "access-token";

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function mockBashira(options: { sessionId: string | null; sse: boolean }) {
  const seen: Array<{ method: string; session: string | null; protocol: string | null; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    seen.push({
      method: String(body.method),
      session: headers.get("mcp-session-id"),
      protocol: headers.get("mcp-protocol-version"),
      body,
    });
    if (body.method === "initialize") {
      const payload = { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } };
      const responseHeaders = new Headers({
        "content-type": options.sse ? "text/event-stream" : "application/json",
      });
      if (options.sessionId) responseHeaders.set("mcp-session-id", options.sessionId);
      return new Response(options.sse ? sse(payload) : JSON.stringify(payload), { status: 200, headers: responseHeaders });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/call") {
      const payload = {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: '{"columns":["starts"],"rows":[[3]]}' }] },
      };
      return new Response(options.sse ? sse(payload) : JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": options.sse ? "text/event-stream" : "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, seen };
}

async function handshake(server: ReturnType<typeof mockBashira>) {
  let id = 0;
  const opened = await initializeMcpSession({
    url,
    token,
    fetchImpl: server.fetchImpl,
    nextId: () => ++id,
    clientInfo: { name: "jra-bashira-predict", version: "0.1.0" },
  });
  const tool = await postMcp({
    url,
    token,
    session: opened.session,
    fetchImpl: server.fetchImpl,
    body: { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "get_races", arguments: {} } },
  });
  return { opened, tool, seen: server.seen };
}

describe("MCP session id", () => {
  it("treats a missing or blank session header as absent", () => {
    expect(readMcpSessionId(null)).toBeNull();
    expect(readMcpSessionId("  ")).toBeNull();
    expect(readMcpSessionId("sess-1")).toBe("sess-1");
  });

  it("continues without Mcp-Session-Id when initialize does not return one", async () => {
    const result = await handshake(mockBashira({ sessionId: null, sse: false }));
    expect(result.opened.session).toEqual({ id: null, protocol: "2025-06-18" });
    expect(result.seen.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(result.seen[0]?.session).toBeNull();
    expect(result.seen[1]?.session).toBeNull();
    expect(result.seen[1]?.protocol).toBe("2025-06-18");
    expect(result.seen[2]?.session).toBeNull();
    expect(unwrapToolResult(result.tool.result)).toEqual({ columns: ["starts"], rows: [[3]] });
  });

  it("sends the session id when initialize returns one, including over SSE", async () => {
    const json = await handshake(mockBashira({ sessionId: "sess-json", sse: false }));
    expect(json.opened.session.id).toBe("sess-json");
    expect(json.seen[1]?.session).toBe("sess-json");
    expect(json.seen[2]?.session).toBe("sess-json");
    expect(json.seen[2]?.protocol).toBe("2025-06-18");

    const stream = await handshake(mockBashira({ sessionId: null, sse: true }));
    expect(stream.opened.session.id).toBeNull();
    expect(stream.seen[1]?.session).toBeNull();
    expect(stream.seen[2]?.session).toBeNull();
    expect(unwrapToolResult(stream.tool.result)).toEqual({ columns: ["starts"], rows: [[3]] });

    const streamWithId = await handshake(mockBashira({ sessionId: "sess-sse", sse: true }));
    expect(streamWithId.opened.session.id).toBe("sess-sse");
    expect(streamWithId.seen.every((call, index) => index === 0 || call.session === "sess-sse")).toBe(true);
    expect(unwrapToolResult(streamWithId.tool.result)).toEqual({ columns: ["starts"], rows: [[3]] });
  });
});
