import { JobError } from "./types";

export interface McpTool {
  name: string;
  inputSchema?: unknown;
}

export interface ToolShape {
  argNames: string[];
  required: string[];
  fields: string[];
}

export interface ToolCatalog {
  tools: Record<string, ToolShape>;
}

export function catalogFromTools(tools: McpTool[]): ToolCatalog {
  const catalog: ToolCatalog = { tools: {} };
  for (const tool of tools) {
    if (!tool?.name) continue;
    catalog.tools[tool.name] = {
      argNames: topLevelProperties(tool.inputSchema),
      required: requiredKeys(tool.inputSchema),
      fields: collectPropertyNames(tool.inputSchema),
    };
  }
  return catalog;
}

export function assertToolArgs(
  catalog: ToolCatalog,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const shape = catalog.tools[toolName];
  if (!shape) {
    throw new JobError(
      `BASHIRA tools/list に ${toolName} がありません。見つかったツール: ${Object.keys(catalog.tools).join(", ") || "なし"}`,
      false,
    );
  }
  for (const key of shape.required) {
    if (!(key in args)) {
      throw new JobError(`${toolName} の必須引数 ${key} が tools/list に対して不足しています`, false);
    }
  }
  for (const key of Object.keys(args)) {
    if (!shape.argNames.includes(key)) {
      throw new JobError(
        `${toolName} の引数 ${key} は tools/list の properties にありません（${shape.argNames.join(", ")}）`,
        false,
      );
    }
  }
}

export function assertFields(catalog: ToolCatalog, toolName: string, fields: string[]): void {
  const shape = catalog.tools[toolName];
  if (!shape) {
    throw new JobError(`BASHIRA tools/list に ${toolName} がありません`, false);
  }
  const missing = fields.filter((field) => !shape.fields.includes(field));
  if (missing.length > 0) {
    throw new JobError(
      `${toolName} のスキーマに ${missing.join(", ")} がありません。推測では呼びません`,
      false,
    );
  }
}

function topLevelProperties(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.keys(properties);
}

function requiredKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
}

export function collectPropertyNames(schema: unknown, acc = new Set<string>()): string[] {
  walk(schema, acc);
  return [...acc];
}

function walk(schema: unknown, acc: Set<string>): void {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const item of schema) walk(item, acc);
    return;
  }
  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const key of Object.keys(record.properties)) acc.add(key);
  }
  if (Array.isArray(record.enum)) {
    for (const item of record.enum) {
      if (typeof item === "string") acc.add(item);
    }
  }
  for (const value of Object.values(record)) walk(value, acc);
}
