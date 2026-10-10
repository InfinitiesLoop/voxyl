// MCP over HTTP (Streamable HTTP, JSON responses only), as a pure function of a backend.
//
// Used by the Worker (the backend is the user's relay object) and by the Node headless host
// (the backend is an in-memory project). No transport here: the caller owns HTTP, auth and
// CORS. Notifications and requests that need no backend are answered without touching it,
// which matters on the Worker, where waking a Durable Object is the thing that costs.

import type { McpToolResult, ToolSpec } from "./protocol.ts";

type Json = Record<string, unknown>;

export interface McpBackend {
  /** Shown to the model on connect. */
  readonly instructions: string;
  tools(): Promise<readonly ToolSpec[]>;
  call(name: string, args: Json): Promise<McpToolResult>;
}

/** A failure the agent should read as a tool error, not as a protocol error. */
export class RelayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface McpHttpReply {
  readonly status: number;
  /** Absent for 202 (only notifications were sent). */
  readonly body?: unknown;
}

const PROTOCOL = "2025-06-18";

/** A tool result for an error: the envelope shape the tools use, as one text block. */
export function errorResult(code: string, message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message } }) }],
    isError: true,
  };
}

/** Handles one HTTP POST body: a message or a batch of them. */
export async function handleMcpBody(body: unknown, backend: McpBackend): Promise<McpHttpReply> {
  const batch = Array.isArray(body);
  const messages: unknown[] = batch ? body : [body];
  if (messages.length === 0) {
    return { status: 400, body: rpcFailure(null, -32600, "An empty batch is not a request.") };
  }
  const replies = (await Promise.all(messages.map((m) => handleMessage(m, backend)))).filter(
    (reply): reply is Json => reply !== undefined,
  );
  if (replies.length === 0) return { status: 202 };
  return { status: 200, body: batch ? replies : replies[0] };
}

function rpcFailure(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(message: unknown, backend: McpBackend): Promise<Json | undefined> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return rpcFailure(null, -32600, "Not a JSON-RPC message.");
  }
  const { id, method } = message as Json;
  // No id: a notification (initialized, cancelled, ...). Nothing to answer.
  if (id === undefined || id === null) return undefined;
  try {
    const params = ((message as Json).params as Json | undefined) ?? {};
    const result = await dispatch(String(method), params, backend);
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32000;
    return rpcFailure(id, code, error instanceof Error ? error.message : String(error));
  }
}

async function dispatch(method: string, params: Json, backend: McpBackend): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "voxyl", title: "Voxyl", version: "0.0.0" },
        instructions: backend.instructions,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: await backend.tools() };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "") throw new RpcError(-32602, "tools/call needs a tool name.");
      const given = params.arguments;
      const args = (typeof given === "object" && given !== null ? given : {}) as Json;
      try {
        return await backend.call(name, args);
      } catch (error) {
        if (error instanceof RelayError) return errorResult(error.code, error.message);
        throw error;
      }
    }
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** Whether a body holds a request that needs the backend's live state (see the file comment). */
export function needsBackend(body: unknown): boolean {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.some((m) => {
    const method = (m as { method?: unknown } | null)?.method;
    return method === "tools/list" || method === "tools/call";
  });
}
