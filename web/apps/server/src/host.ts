// Headless MCP host. Claude Code (or a test) speaks Streamable HTTP to this process, and
// the tools run here on an in-memory project. Nothing is forwarded to a browser tab.
//
// This is the no-tab half of the production path (.plans/web-migration.md). The other half
// is the relay: when a tab holds the project, the call runs in that tab, on the world the
// view is already drawing, so the edit shows up the same way a click does. The tab does not
// subscribe to this endpoint. MCP's GET/SSE stream is for the agent (progress, resource
// updates). This host does not offer it: there is no one to notify, and an open browser is
// a different writer, reached later over the relay, not over SSE.
//
// Loopback only, one project, gone when the process exits. 47823 is Godot, 47824 is the
// dev bridge (pnpm bridge), so this takes the next port.
//
//   node apps/server/src/host.ts [--port 47825]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { callTool, listTools, MemoryHost, type ToolEnvelope, type ToolHost } from "@voxyl/tools";

const INSTRUCTIONS =
  "Voxyl headless host: no editor tab is attached, so nobody is watching these edits. " +
  "They live in this process until it exits. Call status first, and guide for the conventions. " +
  "Cells hold semantic names, never materials. capture and export_schematic need an editor " +
  "tab and will fail here.";

type Json = Record<string, unknown>;

export interface Headless {
  readonly port: number;
  /** The project the tools are editing. Tests read it; the process owns it. */
  readonly memory: MemoryHost;
  close(): Promise<void>;
}

/**
 * The tool host the calls see. Effects (a picture, a download, switching the open project in
 * a tab) are left off, so those tools answer `unavailable` instead of pretending they ran.
 */
function toolHost(memory: MemoryHost): ToolHost {
  return {
    get project() {
      return memory.project;
    },
    editorAttached: false,
    newId: () => memory.newId(),
    changed: (project, info) => memory.changed(project, info),
    libraries: () => memory.libraries(),
    clipboard: memory.clipboard,
    sharedPalettes: memory.sharedPalettes,
    prefabs: memory.prefabs,
    projects: memory.projects,
  };
}

function mcpResult(envelope: ToolEnvelope): Json {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: !envelope.ok,
  };
}

export async function startHost(options: { port?: number } = {}): Promise<Headless> {
  const memory = MemoryHost.create();
  const host = toolHost(memory);

  async function dispatch(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "voxyl", title: "Voxyl", version: "0.0.0" },
          instructions: INSTRUCTIONS,
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: listTools().map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          })),
        };
      case "tools/call":
        return mcpResult(
          await callTool(host, String(params.name ?? ""), (params.arguments as Json) ?? {}),
        );
      case "resources/list":
        return { resources: [] };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  async function handleRpc(message: Json): Promise<Json | undefined> {
    const { id, method } = message;
    if (id === undefined || id === null) return undefined;
    try {
      const result = await dispatch(String(method), (message.params as Json) ?? {});
      return { jsonrpc: "2.0", id: id as never, result };
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32000;
      return {
        jsonrpc: "2.0",
        id: id as never,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  const server = createServer((req, res) => {
    void route(req, res, handleRpc);
  });
  const port = options.port ?? 47825;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    memory,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    ...CORS,
    "content-type": "application/json",
    "cache-control": "no-store",
    "mcp-session-id": "voxyl-headless",
  });
  res.end(body);
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  handleRpc: (message: Json) => Promise<Json | undefined>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (url.pathname !== "/mcp") return send(res, 404, '{"error":"not found"}');
  // No SSE. Server-initiated MCP messages are for the agent, and this host has none.
  // An open editor is not a subscriber of this endpoint.
  if (req.method === "GET" || req.method === "DELETE")
    return send(res, 405, '{"error":"POST only"}');
  if (req.method !== "POST") return send(res, 405, '{"error":"POST only"}');
  let body: Json | Json[];
  try {
    body = JSON.parse(await readBody(req)) as Json | Json[];
  } catch {
    return send(res, 400, '{"error":"bad json"}');
  }
  let batch = false;
  let messages: Json[];
  if (Array.isArray(body)) {
    batch = true;
    messages = body;
  } else {
    messages = [body];
  }
  const replies = (await Promise.all(messages.map((message) => handleRpc(message)))).filter(
    (reply): reply is Json => reply !== undefined,
  );
  if (replies.length === 0) return send(res, 202, "");
  send(res, 200, JSON.stringify(batch ? replies : replies[0]));
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 47825;
  startHost({ port })
    .then((host) => {
      const endpoint = `http://127.0.0.1:${host.port}/mcp`;
      console.log(`Voxyl headless host listening on ${endpoint}`);
      console.log("One in-memory project. No browser tab is attached; edits are not shown live.");
      console.log("Claude Code, once, under a name that is not the dev bridge:");
      console.log(`  claude mcp add --scope user --transport http voxyl-headless ${endpoint}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
