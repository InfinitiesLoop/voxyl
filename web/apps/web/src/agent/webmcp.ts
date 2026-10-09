// WebMCP adapter: publishes the agent tools (@voxyl/tools) to an agent that lives in the
// browser, with no server. WebMCP is a proposed web API: the page tells the browser what tools
// it offers, and a browser-side agent (an extension, the browser's own assistant) calls them.
//
// The spec is mid-move. It started as `navigator.modelContext` and is moving to
// `document.modelContext`; today it exists only behind Chrome flags or an origin trial. So this
// feature-detects both (document first), does nothing when neither is there, and is written to
// survive the small differences between drafts:
//   - registerTool(tool) may return nothing, a handle with unregister(), or take an
//     { signal } option; the model context may offer unregisterTool(name). We use whichever
//     exists when disposing.
//   - registering a name twice may throw (React's dev double mount, a reload of the adapter):
//     that is ignored, the earlier registration keeps working.
//
// The tools themselves run in the world worker; this file only forwards. Their answer is the
// envelope callTool returns, sent back as one text block with isError set from `ok`.

import type { ToolEnvelope, ToolImage, ToolListing } from "@voxyl/tools";

/** What the adapter needs from the app: the tool list and a way to call one. */
export interface ToolClient {
  tools(): Promise<readonly ToolListing[]>;
  call(name: string, args: unknown): Promise<ToolEnvelope>;
}

/** The result shape MCP tools return. */
export interface McpResult {
  [key: string]: unknown;
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError: boolean;
}

/** A tool as WebMCP's registerTool takes it. */
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  execute(input: unknown): Promise<McpResult>;
}

/** The part of the model context we use. Everything beyond registerTool is optional. */
export interface ModelContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): void;
}

/** Where the model context lives, if the browser has it: `document` first, then `navigator`. */
export function findModelContext(
  doc: object = document,
  nav: object = navigator,
): ModelContext | null {
  for (const holder of [doc, nav]) {
    const context = (holder as { modelContext?: ModelContext }).modelContext;
    if (context && typeof context.registerTool === "function") return context;
  }
  return null;
}

/**
 * Wraps a tool envelope the way an MCP client expects a tool result: the envelope as one text
 * block, and each of its `images` as an image block (the text keeps only their labels).
 */
export function mcpResult(envelope: ToolEnvelope): McpResult {
  const { images, ...rest } = envelope as ToolEnvelope & { images?: readonly ToolImage[] };
  const text =
    images && images.length > 0
      ? { ...rest, images: images.map((i) => ({ label: i.label ?? "", mimeType: i.mimeType })) }
      : rest;
  return {
    content: [
      { type: "text", text: JSON.stringify(text) },
      ...(images ?? []).map((i) => ({
        type: "image" as const,
        data: i.data,
        mimeType: i.mimeType,
      })),
    ],
    isError: !envelope.ok,
  };
}

/**
 * Registers every tool with the browser's model context, if it has one. Returns a function
 * that withdraws them again; it is safe to call before registration has finished, and twice.
 * `context` is for tests.
 */
export function registerWebMcp(
  client: ToolClient,
  context: ModelContext | null = findModelContext(),
): () => void {
  if (!context) return () => {};
  const abort = new AbortController();
  const handles: unknown[] = [];
  const names: string[] = [];
  let disposed = false;

  const registered = client.tools().then((listing) => {
    for (const tool of listing) {
      if (disposed) return;
      try {
        const handle = context.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { ...tool.annotations },
            execute: async (input) => mcpResult(await client.call(tool.name, input)),
          },
          { signal: abort.signal },
        );
        handles.push(handle);
        names.push(tool.name);
      } catch {
        // Already registered (a duplicate name), or this draft rejects something about the
        // tool. Either way the other tools should still go in.
      }
    }
  });
  // A failed listing (the worker is gone) means there is nothing to register or withdraw.
  registered.catch(() => {});

  return () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    for (const handle of handles) {
      try {
        (handle as { unregister?(): void } | null | undefined)?.unregister?.();
      } catch {}
    }
    for (const name of names) {
      try {
        context.unregisterTool?.(name);
      } catch {}
    }
  };
}
