import type { McpTool } from "../schema";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolFailure {
  ok: false;
  message: string;
  retryable: boolean;
  code: "auth" | "upstream" | "budget";
  results?: unknown[];
}

export interface BashiraPort {
  listTools(): Promise<{ ok: true; tools: McpTool[] } | ToolFailure>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; data: unknown } | ToolFailure>;
  callTools(calls: ToolCall[]): Promise<{ ok: true; results: unknown[] } | ToolFailure>;
}
