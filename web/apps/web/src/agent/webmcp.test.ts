import type { ToolEnvelope, ToolListing } from "@voxyl/tools";
import { describe, expect, it, vi } from "vitest";
import {
  findModelContext,
  type ModelContext,
  mcpResult,
  registerWebMcp,
  type ToolClient,
  type WebMcpTool,
} from "./webmcp.ts";

const textOf = (block: unknown) => (block as { text?: string } | undefined)?.text ?? "";
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const listing: ToolListing[] = [
  {
    name: "status",
    title: "Status",
    description: "d1",
    inputSchema: { type: "object" },
    annotations,
  },
  {
    name: "place",
    title: "Place",
    description: "d2",
    inputSchema: { type: "object" },
    annotations,
  },
];

function fakeClient(answer: ToolEnvelope = { ok: true, cells: 1 }) {
  const call = vi.fn(async () => answer);
  const client: ToolClient = { tools: async () => listing, call };
  return { client, call };
}

function fakeContext(options: { duplicate?: string; handles?: boolean } = {}) {
  const tools = new Map<string, WebMcpTool>();
  const unregistered: string[] = [];
  const context: ModelContext = {
    registerTool(tool) {
      if (tool.name === options.duplicate) throw new Error("duplicate tool name");
      tools.set(tool.name, tool);
      return options.handles
        ? { unregister: () => unregistered.push(`handle:${tool.name}`) }
        : undefined;
    },
    unregisterTool(name) {
      unregistered.push(name);
      tools.delete(name);
    },
  };
  return { context, tools, unregistered };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("findModelContext", () => {
  it("prefers document over navigator and ignores a missing or malformed one", () => {
    const a = fakeContext().context;
    const b = fakeContext().context;
    expect(findModelContext({ modelContext: a }, { modelContext: b })).toBe(a);
    expect(findModelContext({}, { modelContext: b })).toBe(b);
    expect(findModelContext({}, {})).toBeNull();
    expect(findModelContext({ modelContext: {} }, {})).toBeNull();
  });
});

describe("registerWebMcp", () => {
  it("does nothing without a model context", () => {
    const { client } = fakeClient();
    const dispose = registerWebMcp(client, null);
    expect(() => dispose()).not.toThrow();
  });

  it("registers every tool with its schema and annotations", async () => {
    const { client } = fakeClient();
    const { context, tools } = fakeContext();
    registerWebMcp(client, context);
    await settle();
    expect([...tools.keys()]).toEqual(["status", "place"]);
    const place = tools.get("place");
    expect(place?.description).toBe("d2");
    expect(place?.inputSchema).toEqual({ type: "object" });
    expect(place?.annotations.readOnlyHint).toBe(true);
  });

  it("forwards execute to the client and wraps the envelope as an MCP result", async () => {
    const { client, call } = fakeClient({ ok: true, cells: 3 });
    const { context, tools } = fakeContext();
    registerWebMcp(client, context);
    await settle();
    const result = await tools.get("place")?.execute({ at: [1, 2, 3] });
    expect(call).toHaveBeenCalledWith("place", { at: [1, 2, 3] });
    expect(result?.isError).toBe(false);
    expect(JSON.parse(textOf(result?.content[0]))).toEqual({ ok: true, cells: 3 });
  });

  it("marks a failed envelope as an error", () => {
    const failed: ToolEnvelope = { ok: false, error: { code: "no_project", message: "none" } };
    const result = mcpResult(failed);
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result.content[0])).error.code).toBe("no_project");
  });

  it("turns an envelope's images into MCP image blocks and keeps base64 out of the text", () => {
    const envelope = {
      ok: true,
      framed: [0, 0, 0, 1, 1, 1],
      images: [{ mimeType: "image/png", data: "QUJD", label: "front" }],
    } as ToolEnvelope;
    const result = mcpResult(envelope);
    expect(result.isError).toBe(false);
    expect(result.content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
    const text = JSON.parse(textOf(result.content[0]));
    expect(text.images).toEqual([{ label: "front", mimeType: "image/png" }]);
    expect(JSON.stringify(text)).not.toContain("QUJD");
  });

  it("tolerates a duplicate name and still registers the rest", async () => {
    const { client } = fakeClient();
    const { context, tools } = fakeContext({ duplicate: "status" });
    registerWebMcp(client, context);
    await settle();
    expect([...tools.keys()]).toEqual(["place"]);
  });

  it("unregisters on dispose, by handle and by name, once", async () => {
    const { client } = fakeClient();
    const { context, tools, unregistered } = fakeContext({ handles: true });
    const dispose = registerWebMcp(client, context);
    await settle();
    dispose();
    dispose();
    expect(tools.size).toBe(0);
    expect(unregistered).toEqual(["handle:status", "handle:place", "status", "place"]);
  });

  it("registers nothing when disposed before the listing arrives", async () => {
    const { client } = fakeClient();
    const { context, tools } = fakeContext();
    registerWebMcp(client, context)();
    await settle();
    expect(tools.size).toBe(0);
  });

  it("survives a context without unregisterTool and a listing that fails", async () => {
    const tools: string[] = [];
    const context: ModelContext = { registerTool: (t) => void tools.push(t.name) };
    const { client } = fakeClient();
    const dispose = registerWebMcp(client, context);
    await settle();
    expect(() => dispose()).not.toThrow();
    const broken: ToolClient = {
      tools: async () => Promise.reject(new Error("gone")),
      call: async () => ({ ok: true }),
    };
    expect(() => registerWebMcp(broken, fakeContext().context)()).not.toThrow();
    await settle();
  });
});
