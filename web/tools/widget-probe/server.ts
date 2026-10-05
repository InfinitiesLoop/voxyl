// ChatGPT widget probe: a dependency-free MCP server (Streamable HTTP, stateless JSON replies)
// whose widget reports what the ChatGPT sandbox allows, plus a relay tool that runs inside the
// open widget over its live channel (WebSocket, else server-sent events).
//   node tools/widget-probe/server.ts [--port 8787]
// Expose it with `cloudflared tunnel --url http://localhost:8787`, add <tunnel>/mcp as an app in
// ChatGPT developer mode, then ask ChatGPT to open the Voxyl probe. Everything the widget
// reports is appended to shots/widget-probe.jsonl. GET /probe/widget.html serves the widget
// outside ChatGPT for local checks.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8787;
const widgetFile = fileURLToPath(new URL("./widget.html", import.meta.url));
const shotsDir = fileURLToPath(new URL("../../shots/", import.meta.url));
const reportFile = `${shotsDir}widget-probe.jsonl`;
mkdirSync(shotsDir, { recursive: true });

const RESOURCE = "ui://voxyl/probe.html";
const MIME = "text/html;profile=mcp-app";
const RELAY_TIMEOUT_MS = 20_000;
/** Move a relayed op to the next downlink when this one hasn't answered by then. */
const FALLBACK_AFTER_MS = 4_000;
/**
 * Cloudflare drops a WebSocket that carries nothing for 100 s. Ping frames keep it open, and the
 * browser answers them itself, even in a throttled background tab.
 */
const WS_PING_MS = 25_000;

type Json = Record<string, unknown>;
/** A widget's downlinks: a WebSocket, server-sent events, or a streamed POST response (ndjson). */
type Widget = {
  session: string;
  ws?: Duplex | undefined;
  sse?: ServerResponse | undefined;
  down?: ServerResponse | undefined;
  seen: number;
  last?: Json;
};
type Via = "ws" | "down" | "sse";
type Relayed = { reply: Json; ms: number; via: string; session: string };

const widgets = new Map<string, Widget>();
const pending = new Map<string, (reply: Json) => void>();
let lastReport: Json | undefined;

function log(kind: string, data: Json, quiet = false) {
  appendFileSync(reportFile, `${JSON.stringify({ t: new Date().toISOString(), kind, ...data })}\n`);
  if (!quiet) console.log(`[${new Date().toLocaleTimeString()}] ${kind} ${JSON.stringify(data)}`);
}

function widget(session: string): Widget {
  let w = widgets.get(session);
  if (!w) {
    w = { session, seen: Date.now() };
    widgets.set(session, w);
  }
  w.seen = Date.now();
  return w;
}

/** The origin ChatGPT reached us on (the tunnel), which the widget must call back to. */
function originOf(req: IncomingMessage): string {
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const host = header("x-forwarded-host") ?? header("host") ?? `localhost:${port}`;
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = header("x-forwarded-proto") ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

function widgetHtml(origin: string): string {
  return readFileSync(widgetFile, "utf8").replaceAll("__ORIGIN__", origin);
}

function widgetMeta(origin: string): Json {
  const domains = [origin, origin.replace(/^http/, "ws")];
  return {
    ui: { prefersBorder: true, csp: { connectDomains: domains, resourceDomains: [] } },
    "openai/widgetCSP": { connect_domains: domains, resource_domains: [] },
    "openai/widgetDescription": "A diagnostics panel that tests the widget sandbox.",
  };
}

// --- MCP -----------------------------------------------------------------------------------

const noArgs = { type: "object", properties: {}, additionalProperties: false };
const TOOLS = [
  {
    name: "voxyl_probe_open",
    title: "Open the Voxyl probe",
    description:
      "Open the Voxyl widget probe. It tests what the widget sandbox allows (WebSocket, server-sent " +
      "events, WebGPU, workers, storage, timers) and reports the results to the server.",
    inputSchema: noArgs,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: RESOURCE },
      "openai/outputTemplate": RESOURCE,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Opening the probe",
      "openai/toolInvocation/invoked": "Probe open",
    },
  },
  {
    name: "voxyl_probe_relay",
    title: "Run an op in the probe widget",
    description:
      "Run an operation inside the open probe widget, relayed over the widget's live connection " +
      "to the server. Ops: echo (returns text), count (increments a counter shown in the widget), " +
      "caps (the widget's capability report), snapshot (an image rendered by the widget).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["echo", "count", "caps", "snapshot"] },
        text: { type: "string", description: "Text for echo." },
        via: {
          type: "string",
          enum: ["ws", "down", "sse"],
          description:
            "Downlink to use: ws (WebSocket), down (streamed POST response) or sse. Default: the first one attached, in that order.",
        },
      },
      required: ["op"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "voxyl_probe_results",
    title: "Probe results",
    description: "The latest capability report and heartbeats from probe widgets.",
    inputSchema: noArgs,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { "openai/widgetAccessible": true },
  },
];

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function callTool(name: string, args: Json): Promise<Json> {
  log("tool", { name, args });
  if (name === "voxyl_probe_open") {
    const session = randomUUID().slice(0, 8);
    return {
      content: [
        {
          type: "text",
          text: `Probe widget opening (tool session ${session}). It reports to the server; call voxyl_probe_results after a few seconds.`,
        },
      ],
      structuredContent: { session },
    };
  }
  if (name === "voxyl_probe_results") {
    const live = [...widgets.values()].map((w) => ({
      session: w.session,
      channels: [w.ws && "ws", w.down && "down", w.sse && "sse"].filter(Boolean),
      secondsSinceSeen: Math.round((Date.now() - w.seen) / 1000),
      lastHeartbeat: w.last,
    }));
    return text(JSON.stringify({ report: lastReport ?? null, widgets: live }, null, 1));
  }
  if (name === "voxyl_probe_relay") {
    const op = String(args.op ?? "");
    try {
      const r = await relay(op, args);
      const summary = `${op} ran in widget ${r.session} via ${r.via}, ${r.ms} ms round trip`;
      log("relay", { op, via: r.via, ms: r.ms, session: r.session });
      const png = r.reply.png;
      if (op === "snapshot" && typeof png === "string") {
        return {
          content: [
            { type: "text", text: `${summary}; ${r.reply.width}x${r.reply.height} PNG` },
            { type: "image", data: png, mimeType: "image/png" },
          ],
        };
      }
      return text(`${summary}\n${JSON.stringify(r.reply, null, 1)}`);
    } catch (e) {
      log("relay-error", { op, error: String(e) });
      return text(String(e instanceof Error ? e.message : e), true);
    }
  }
  return text(`Unknown tool ${name}`, true);
}

async function dispatch(method: string, params: Json, origin: string): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "voxyl-probe", version: "0.0.1" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(String(params.name), (params.arguments as Json) ?? {});
    case "resources/list":
      return {
        resources: [
          { uri: RESOURCE, name: "voxyl-probe", mimeType: MIME, _meta: widgetMeta(origin) },
        ],
      };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read":
      if (params.uri !== RESOURCE) throw new RpcError(-32002, `Unknown resource ${params.uri}`);
      log("resource-read", { origin });
      return {
        contents: [
          { uri: RESOURCE, mimeType: MIME, text: widgetHtml(origin), _meta: widgetMeta(origin) },
        ],
      };
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleRpc(msg: Json, origin: string): Promise<Json | undefined> {
  const { id, method } = msg;
  if (id === undefined || id === null) {
    log("mcp-notify", { method }, true);
    return undefined;
  }
  log("mcp", { method }, method === "ping");
  try {
    const result = await dispatch(String(method), (msg.params as Json) ?? {}, origin);
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message: String(e instanceof Error ? e.message : e) },
    };
  }
}

// --- Relay ---------------------------------------------------------------------------------

function push(w: Widget, via: Via, msg: string) {
  if (via === "ws" && w.ws) wsSend(w.ws, msg);
  else if (via === "down") w.down?.write(`${msg}\n`);
  else w.sse?.write(`event: message\ndata: ${msg}\n\n`);
}

function relay(op: string, args: Json): Promise<Relayed> {
  const asked = typeof args.via === "string" ? (args.via as Via) : undefined;
  const has = (x: Widget, v: Via) => (v === "ws" ? !!x.ws : v === "down" ? !!x.down : !!x.sse);
  const order: Via[] = asked ? [asked] : ["ws", "down", "sse"];
  const w = [...widgets.values()]
    .filter((x) => order.some((v) => has(x, v)))
    .sort((a, b) => b.seen - a.seen)[0];
  if (!w) {
    const which = asked ? ` over ${asked}` : "";
    throw new Error(`No probe widget is attached${which}. Open it with voxyl_probe_open first.`);
  }
  // Try each attached downlink in turn: a socket can be dead before the server notices. The op
  // keeps its id across attempts and the widget answers a repeat from its cache, so an op that
  // arrives twice still runs once.
  const vias = order.filter((v) => has(w, v));
  const id = randomUUID();
  const start = performance.now();
  const tried: string[] = [];
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (i: number) => {
      const via = vias[i];
      if (!via) {
        pending.delete(id);
        reject(new Error(`Widget ${w.session} did not answer (tried ${tried.join(", ")}).`));
        return;
      }
      tried.push(via);
      push(w, via, JSON.stringify({ type: "op", id, op, args, via }));
      const left = RELAY_TIMEOUT_MS - (performance.now() - start);
      timer = setTimeout(() => attempt(i + 1), i + 1 < vias.length ? FALLBACK_AFTER_MS : left);
    };
    pending.set(id, (reply) => {
      clearTimeout(timer);
      pending.delete(id);
      const ms = Math.round(performance.now() - start);
      resolve({ reply, ms, via: tried.join(" then "), session: w.session });
    });
    attempt(0);
  });
}

function settle(m: Json) {
  const done = pending.get(String(m.id));
  if (done) done((m.result as Json) ?? {});
}

// --- WebSocket (RFC 6455, just enough for text frames) ---------------------------------------

function wsSend(socket: Duplex, message: string) {
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

function wsAccept(req: IncomingMessage, socket: Duplex) {
  const url = new URL(req.url ?? "/", "http://x");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/probe/ws" || typeof key !== "string") {
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
  const session = url.searchParams.get("session") ?? "anon";
  const w = widget(session);
  w.ws = socket;
  log("ws-open", { session, origin: req.headers.origin });

  let buf = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let lastPong = Date.now();
  const onMessage = (raw: string) => {
    w.seen = Date.now();
    const m = JSON.parse(raw) as Json;
    if (m.type === "ping") wsSend(socket, JSON.stringify({ type: "pong", k: m.k }));
    else if (m.type === "reply") settle(m);
  };
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
      if (mask)
        for (let i = 0; i < len; i++)
          payload.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i & 3), i);
      buf = buf.subarray(off + len);
      const opcode = b0 & 15;
      if (opcode === 0 || opcode === 1) {
        fragments.push(payload);
        if (b0 & 0x80) {
          onMessage(Buffer.concat(fragments).toString("utf8"));
          fragments = [];
        }
      } else if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
      } else if (opcode === 9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      } else if (opcode === 10) {
        lastPong = Date.now();
      }
    }
  });
  // Keepalive, and a socket that stops answering pings is dead even if TCP hasn't said so.
  const keepAlive = setInterval(() => {
    if (Date.now() - lastPong > 2.5 * WS_PING_MS) {
      log("ws-dead", { session, silentS: Math.round((Date.now() - lastPong) / 1000) });
      socket.destroy();
      return;
    }
    socket.write(Buffer.from([0x89, 0]));
  }, WS_PING_MS);
  const close = () => {
    clearInterval(keepAlive);
    if (w.ws === socket) {
      w.ws = undefined;
      log("ws-close", { session });
    }
  };
  socket.on("close", close);
  socket.on("error", close);
}

// --- HTTP ----------------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
  "access-control-max-age": "86400",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = "application/json") {
  res.writeHead(status, { ...CORS, "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (path === "/mcp") {
    if (req.method !== "POST") return send(res, 405, '{"error":"POST only"}');
    const body = JSON.parse(await readBody(req)) as Json | Json[];
    const origin = originOf(req);
    const batch = Array.isArray(body);
    const replies = (
      await Promise.all((batch ? body : [body]).map((m) => handleRpc(m, origin)))
    ).filter(Boolean);
    if (replies.length === 0) return send(res, 202, "");
    return send(res, 200, JSON.stringify(batch ? replies : replies[0]));
  }

  if (path === "/probe/widget.html") return send(res, 200, widgetHtml(originOf(req)), "text/html");
  if (path === "/probe/echo") return send(res, 200, await readBody(req));

  if (path === "/probe/stream") {
    res.writeHead(200, {
      ...CORS,
      "content-type": "application/x-ndjson",
      // no-transform stops Cloudflare compressing (and so buffering) the stream.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    for (let i = 0; i < 10; i++) {
      res.write(`${JSON.stringify({ i, t: Date.now() })}\n`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return res.end();
  }

  // Long-lived downlinks. Cloudflare quick tunnels buffer GET responses to the end (no SSE),
  // but stream POST responses, so /probe/down (POST, ndjson) is the one that survives them.
  if (path === "/probe/sse" || (path === "/probe/down" && req.method === "POST")) {
    const via: Via = path === "/probe/sse" ? "sse" : "down";
    const session = url.searchParams.get("session") ?? "anon";
    res.writeHead(200, {
      ...CORS,
      "content-type": via === "sse" ? "text/event-stream" : "application/x-ndjson",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    if (via === "sse") res.write("retry: 2000\n\n");
    const w = widget(session);
    w[via] = res;
    push(w, via, '{"type":"hello"}');
    log(`${via}-open`, { session, origin: req.headers.origin });
    const keepAlive = setInterval(() => push(w, via, '{"type":"ka"}'), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      if (w[via] === res) {
        w[via] = undefined;
        log(`${via}-close`, { session });
      }
    });
    return;
  }

  if (req.method === "POST" && path.startsWith("/probe/")) {
    const m = JSON.parse((await readBody(req)) || "{}") as Json;
    const session = String(m.session ?? "anon");
    if (path === "/probe/ping") {
      // Up by POST, back down the named downlink: the fallback relay's round trip.
      const w = widgets.get(session);
      const via = m.via === "sse" ? "sse" : "down";
      if (w) push(w, via, JSON.stringify({ type: "pong", nonce: m.nonce }));
    } else if (path === "/probe/reply") {
      settle(m);
    } else if (path === "/probe/report") {
      lastReport = m;
      widget(session);
      log("report", m);
    } else if (path === "/probe/heartbeat") {
      const w = widget(session);
      w.last = m;
      log("heartbeat", m, true);
    } else if (path === "/probe/event") {
      log("event", m);
    }
    return send(res, 200, "{}");
  }

  send(res, 404, '{"error":"not found"}');
}

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: String(e) }));
  });
});
server.on("upgrade", wsAccept);
server.listen(port, () => {
  console.log(`voxyl widget probe on http://localhost:${port}/mcp (reports: ${reportFile})`);
});
