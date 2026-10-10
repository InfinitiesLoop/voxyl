// The Voxyl relay: a Cloudflare Worker (api.voxyl.xyz) and one Durable Object per agent token.
//
//   agent  --POST /mcp (Bearer token)-->  Worker  --RPC-->  Relay object  --WebSocket-->  tab
//   tab    --GET  /tab (token in the subprotocol)-->  Worker  -->  the same Relay object
//   tab    --POST /api/token-->  Worker (mints a token; stores nothing)
//
// The Worker is thin on purpose (free plan: 10 ms CPU). It checks the token's signature, which
// needs no lookup, answers the MCP calls that need no tab (initialize, ping, notifications)
// itself, and wakes the object only for tools/list and tools/call. The tools run in the user's
// tab, never here. The routing rules live in @voxyl/relay (RelayCore) and are tested in Node;
// this file is glue to Cloudflare: sockets, hibernation, storage.

import { DurableObject } from "cloudflare:workers";
import {
  errorResult,
  handleMcpBody,
  INSTRUCTIONS,
  type McpBackend,
  type McpToolResult,
  mintToken,
  needsBackend,
  PING,
  PONG,
  parseTabMessage,
  RelayCore,
  RelayError,
  TAB_PROTOCOL,
  type TabLink,
  type ToolSpec,
  verifyToken,
} from "@voxyl/relay";

interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  /** Signs agent tokens. `wrangler secret put TOKEN_SECRET`; `.dev.vars` locally. */
  TOKEN_SECRET?: string;
}

/** What a hibernating socket remembers about its tab. */
interface TabAttachment {
  tabId: string;
  lastActive: number;
}

const MAX_BODY_BYTES = 1_000_000;

// --- The Worker ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin !== null && !allowedOrigin(origin) && url.pathname !== "/mcp") {
      return text("This origin is not allowed.", 403);
    }
    if (request.method === "OPTIONS") return preflight(request, url.pathname);

    if (url.pathname === "/" || url.pathname === "/healthz") {
      return text("Voxyl relay. Agents: https://voxyl.xyz, Home, Agents.\n", 200);
    }
    if (env.TOKEN_SECRET === undefined || env.TOKEN_SECRET === "") {
      return json({ error: "The relay has no TOKEN_SECRET set." }, 503);
    }
    if (url.pathname === "/api/token") return mint(request, env, origin);
    if (url.pathname === "/tab") return connectTab(request, env);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return mcp(request, env, url);
    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;

async function mint(request: Request, env: Env, origin: string | null): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only." }, 405, cors(origin));
  const token = await mintToken(env.TOKEN_SECRET as string);
  return json({ token }, 200, cors(origin));
}

/** The tab's WebSocket: the token rides in the subprotocol, since browsers set no headers. */
async function connectTab(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") return text("Expected a WebSocket.", 426);
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((p) => p.trim());
  const token = offered[0] === TAB_PROTOCOL ? offered[1] : undefined;
  const id = token ? await verifyToken(env.TOKEN_SECRET as string, token) : null;
  if (id === null) return text("Bad token.", 401);
  return env.RELAY.get(env.RELAY.idFromName(id)).fetch(request);
}

async function mcp(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = cors("*");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  // No server-to-agent stream: nothing here speaks first, and the editor is not a subscriber.
  if (request.method !== "POST") {
    return json({ error: "POST only." }, 405, { ...headers, Allow: "POST, OPTIONS" });
  }
  // The token is a Bearer header (Claude Code, Codex) or the path (clients with no header
  // field, such as ChatGPT's connector form: the URL is then the secret).
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
  const token = bearer ?? decodeURIComponent(url.pathname.slice("/mcp/".length));
  const id = token ? await verifyToken(env.TOKEN_SECRET as string, token) : null;
  if (id === null) {
    return json(
      { error: "Missing or invalid token. Get one in Voxyl: Home, Agents, https://voxyl.xyz." },
      401,
      { ...headers, "WWW-Authenticate": "Bearer" },
    );
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413, headers);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Not JSON." }, 400, headers);
  }
  const backend = needsBackend(body) ? relayBackend(env, id) : idleBackend;
  const reply = await handleMcpBody(body, backend);
  if (reply.body === undefined) return new Response(null, { status: reply.status, headers });
  return json(reply.body, reply.status, headers);
}

/** What the object answers, reached by RPC. Only built when the call needs it. */
function relayBackend(env: Env, id: string): McpBackend {
  const stub = env.RELAY.get(env.RELAY.idFromName(id));
  return {
    instructions: INSTRUCTIONS,
    tools: () => stub.tools(),
    call: (name, args) => stub.call(name, args),
  };
}

/** For bodies that need nothing from the object: initialize, ping, notifications. */
const idleBackend: McpBackend = {
  instructions: INSTRUCTIONS,
  tools: () => Promise.resolve([]),
  call: () => Promise.reject(new RelayError("internal", "Not reachable without the relay.")),
};

// --- The Durable Object -------------------------------------------------------------------

/**
 * One agent token's relay. Tabs hold WebSockets to it (hibernating, so an idle relay costs
 * nothing); agent calls arrive as RPC from the Worker and are forwarded to the tab the user
 * used last.
 */
export class Relay extends DurableObject<Env> {
  private readonly core: RelayCore;
  /** The live socket of each tab. A reconnecting tab replaces its old entry. */
  private readonly sockets = new Map<string, WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new RelayCore({
      store: {
        load: async () => (await ctx.storage.get<ToolSpec[]>("tools")) ?? null,
        save: (tools) => ctx.storage.put("tools", tools),
      },
    });
    // Pings from tabs are answered at the edge without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    // Sockets outlive the object's memory: after a wake, find the tabs again.
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as TabAttachment | null;
      if (attachment) this.adopt(attachment, socket);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return text("Expected a WebSocket.", 426);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": TAB_PROTOCOL },
    });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let attachment = socket.deserializeAttachment() as TabAttachment | null;
    if (!attachment) {
      // A new socket must introduce itself first.
      const hello = parseTabMessage(message);
      if (hello?.type !== "hello") {
        socket.close(1008, "Say hello first.");
        return;
      }
      attachment = { tabId: hello.tabId, lastActive: Date.now() };
      socket.serializeAttachment(attachment);
      this.adopt(attachment, socket);
    }
    const { active } = await this.core.onMessage(attachment.tabId, message);
    if (active !== undefined) socket.serializeAttachment({ ...attachment, lastActive: active });
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    this.release(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.release(socket);
  }

  /** Puts a tab's socket into the core, replacing a stale socket of the same tab. */
  private adopt(attachment: TabAttachment, socket: WebSocket): void {
    const old = this.sockets.get(attachment.tabId);
    this.sockets.set(attachment.tabId, socket);
    if (old && old !== socket) {
      try {
        old.close(1000, "Replaced by a newer connection from the same tab.");
      } catch {
        // Already closed.
      }
    }
    const link: TabLink = { send: (data) => socket.send(data) };
    for (const dropped of this.core.attach(attachment.tabId, link, attachment.lastActive)) {
      const extra = this.sockets.get(dropped);
      this.sockets.delete(dropped);
      this.core.detach(dropped);
      extra?.close(1008, "Too many tabs for one connection.");
    }
  }

  /** A socket is gone. Only the tab's current socket takes the tab with it. */
  private release(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as TabAttachment | null;
    if (!attachment || this.sockets.get(attachment.tabId) !== socket) return;
    this.sockets.delete(attachment.tabId);
    this.core.detach(attachment.tabId);
  }

  // RPC from the Worker. An error object loses its class crossing RPC, so failures that the
  // agent should read are returned as a tool result instead of thrown.

  async tools(): Promise<readonly ToolSpec[]> {
    return this.core.tools();
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      return await this.core.call(name, args);
    } catch (error) {
      if (error instanceof RelayError) return errorResult(error.code, error.message);
      throw error;
    }
  }
}

// --- HTTP helpers -------------------------------------------------------------------------

/** Where the app runs: production, Pages previews, and local development. */
function allowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (url.protocol === "https:") {
    return (
      host === "voxyl.xyz" ||
      host.endsWith(".voxyl.xyz") ||
      host === "voxyl.pages.dev" ||
      host.endsWith(".voxyl.pages.dev")
    );
  }
  return (
    url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
  );
}

function cors(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, content-type, mcp-session-id, mcp-protocol-version",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "mcp-session-id",
    Vary: "Origin",
  };
}

function preflight(request: Request, pathname: string): Response {
  const origin = request.headers.get("Origin");
  const open = pathname === "/mcp" || pathname.startsWith("/mcp/");
  return new Response(null, { status: 204, headers: cors(open ? "*" : origin) });
}

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
