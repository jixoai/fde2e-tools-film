/**
 * The WebMCP surface's shared bits (4.1/4.2): the tool def's shape, the response contract, and
 * the page's project — one place so every family answers the same way (T10's protocol notes: a
 * response is always a JSON string; a schema is a complete JSON Schema object; the tool boundary
 * counts tracks 1-based — the conversion happens once, in the edit family's planners).
 */

/** A tool as document.modelContext.registerTool takes it (native or the vendored polyfill). */
export interface WebMCPToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
    consequentialHint?: boolean;
    debugging?: boolean;
  };
}

/** document.modelContext's structural minimum (native or polyfill). */
export interface ModelContextLike {
  registerTool: (tool: WebMCPToolDef) => Promise<unknown>;
  getTools: (options?: Record<string, unknown>) => Promise<Array<{ name: string }>>;
  executeTool: (tool: unknown, input?: Record<string, unknown>) => Promise<string>;
}

/** A tool's answer, always a JSON string. */
export const say = (value: unknown): string => JSON.stringify(value);

/** The project the page has open (/projects/<id>), or null at the launcher. */
export const currentProjectId = (): string | null => /^\/projects\/([\w-]+)/.exec(location.pathname)?.[1] ?? null;

/** A complete JSON Schema object: the caller can send nothing this tool did not ask for. */
export const jsonSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
