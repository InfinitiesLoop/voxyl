// Local MCP bridge. Claude Code speaks Streamable HTTP to 127.0.0.1; the open Voxyl tab
// holds a WebSocket and runs the tools. Bind is loopback only, so nothing off this machine
// can connect. The tab connects from the dev build (see apps/web/src/agent/bridge-client.ts).
//
//   node tools/bridge.ts [--port 47824]
// 47823 is the Godot app's MCP port, so the web bridge uses the next one and the two can run together.

import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

const INSTRUCTIONS =
  "Voxyl is a voxel design tool connected to the user's open editor. Call status first, " +
  "and guide for the conventions. Every edit shows up live and is one undo step. " +
  "Cells hold semantic names, never materials.";

const CALL_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;

interface Tab {
  socket: Duplex;
  send(message: Json): void;
}

export interface Bridge {
  readonly port: number;
  close(): Promise<void>;
}

export async function startBridge(
  options: { port?: number; quiet?: boolean } = {},
): Promise<Bridge> {
  const pending = new Map<string, (value: Json) => void>();
  let tab: Tab | null = null;

  const failPending = (message: string) => {
    for (const [id, done] of pending) {
      pending.delete(id);
      done({ error: message });
    }
  };

  const ask = (message: Json, timeoutMs: number): Promise<Json> => {
    if (!tab) {
      return Promise.reject(
        new Error("No Voxyl tab is connected. Open the app (pnpm dev) and leave it open."),
      );
    }
    const id = randomUUID();
    const socket = tab;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The Voxyl tab did not answer."));
      }, timeoutMs);
      pending.set(id, (value) => {
        clearTimeout(timer);
        if (typeof value.error === "string") reject(new Error(value.error));
        else resolve(value);
      });
      socket.send({ ...message, id });
    });
  };

  const settle = (message: Json) => {
    const done = pending.get(String(message.id));
    if (!done) return;
    pending.delete(String(message.id));
    done(message);
  };

  async function dispatch(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "voxyl", title: "Voxyl", version: "0.0.0" },
          instructions: INSTRUCTIONS,
        };
      case "ping":
        return {};
      case "tools/list": {
        const reply = await ask({ type: "list" }, LIST_TIMEOUT_MS);
        const tools = Array.isArray(reply.tools) ? reply.tools : [];
        return { tools };
      }
      case "tools/call": {
        const name = String(params.name ?? "");
        const reply = await ask(
          { type: "call", name, args: (params.arguments as Json) ?? {} },
          CALL_TIMEOUT_MS,
        );
        return reply.result ?? { content: [{ type: "text", text: "No result." }], isError: true };
      }
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
  server.on("upgrade", (req, socket) => {
    acceptTab(req, socket, {
      onOpen(next) {
        if (tab && tab.socket !== next.socket) tab.socket.destroy();
        tab = next;
        if (!options.quiet) console.log("Voxyl tab connected");
      },
      onMessage: settle,
      onClose(socket) {
        if (tab?.socket === socket) {
          tab = null;
          failPending("The Voxyl tab disconnected.");
          if (!options.quiet) console.log("Voxyl tab disconnected");
        }
      },
    });
  });

  const port = options.port ?? 47824;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    port: actual,
    close: () => closeServer(server, () => tab?.socket.destroy()),
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
    "mcp-session-id": "voxyl",
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
    messages = body as Json[];
  } else {
    messages = [body];
  }
  const replies = (await Promise.all(messages.map((message) => handleRpc(message)))).filter(
    (reply): reply is Json => reply !== undefined,
  );
  if (replies.length === 0) return send(res, 202, "");
  send(res, 200, JSON.stringify(batch ? replies : replies[0]));
}

function closeServer(server: Server, dropTab: () => void): Promise<void> {
  dropTab();
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- WebSocket (RFC 6455, text frames only; the browser masks, we do not) -----------------

function wsSend(socket: Duplex, message: string): void {
  const data = Buffer.from(message);
  const n = data.length;
  let head: Buffer;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) head = Buffer.from([0x81, 126, n >> 8, n & 255]);
  else {
    head = Buffer.alloc(10);
    head.writeUInt8(0x81, 0);
    head.writeUInt8(127, 1);
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  socket.write(Buffer.concat([head, data]));
}

function acceptTab(
  req: IncomingMessage,
  socket: Duplex,
  handlers: {
    onOpen(tab: Tab): void;
    onMessage(message: Json): void;
    onClose(socket: Duplex): void;
  },
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/tab" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const tab: Tab = {
    socket,
    send: (message) => wsSend(socket, JSON.stringify(message)),
  };
  handlers.onOpen(tab);
  let buf = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf.readUInt8(0);
      const b1 = buf.readUInt8(1);
      let len = b1 & 127;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const mask = masked ? buf.subarray(off, off + 4) : undefined;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) {
        for (let i = 0; i < len; i++)
          payload.writeUInt8(payload.readUInt8(i) ^ (mask[i & 3] ?? 0), i);
      }
      buf = buf.subarray(off + len);
      const opcode = b0 & 15;
      if (opcode === 0 || opcode === 1) {
        fragments.push(payload);
        if (b0 & 0x80) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          try {
            handlers.onMessage(JSON.parse(text) as Json);
          } catch {
            // A frame that is not JSON is ignored.
          }
        }
      } else if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
      } else if (opcode === 9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      }
    }
  });
  const close = () => handlers.onClose(socket);
  socket.on("close", close);
  socket.on("error", close);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 47824;
  startBridge({ port })
    .then((bridge) => {
      const endpoint = `http://127.0.0.1:${bridge.port}/mcp`;
      console.log(`Voxyl bridge listening on ${endpoint}`);
      console.log("Open the app (pnpm dev) and leave that tab open.");
      console.log("Claude Code, once:");
      console.log(`  claude mcp add --scope user --transport http voxyl ${endpoint}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
