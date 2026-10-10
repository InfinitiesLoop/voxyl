// This tab's link to the relay (packages/relay, apps/relay). The tab holds one WebSocket open,
// says hello with its tool list, and then runs whatever call the relay forwards, on the live
// editor. The relay never runs a tool itself.
//
// The socket is kept alive by a ping every 30 s (the relay answers pong without waking), and
// rebuilt if the pongs stop, if the network drops, or if the relay restarts. Hidden tabs keep
// working: the world lives in a worker, which the browser does not throttle the way timers on
// a page are.

import {
  DEAD_AFTER_MS,
  PING,
  PING_EVERY_MS,
  PONG,
  type RelayToTab,
  TAB_PROTOCOL,
  type TabToRelay,
} from "@voxyl/relay";
import type { RelayState } from "./agent-access.ts";
import type { ToolClient } from "./webmcp.ts";
import { mcpResult } from "./webmcp.ts";

export interface RelayLink {
  readonly url: string;
  readonly token: string;
  onState(state: RelayState): void;
  /** For tests. */
  readonly socket?: (url: string, protocols: string[]) => WebSocket;
}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** The relay's WebSocket address for a base like https://api.voxyl.xyz. */
export function tabUrl(base: string): string {
  return `${base.replace(/^http/, "ws").replace(/\/+$/, "")}/tab`;
}

/** Connects and stays connected. Returns a function that disconnects for good. */
export function connectRelay(client: ToolClient, link: RelayLink): () => void {
  const tabId = crypto.randomUUID();
  const open = link.socket ?? ((url, protocols) => new WebSocket(url, protocols));
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer = 0;
  let pingTimer = 0;
  let delay = RETRY_MIN_MS;
  let lastPong = 0;

  const send = (message: TabToRelay) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const markActive = () => {
    if (document.visibilityState === "visible") send({ type: "active" });
  };

  const connect = () => {
    if (stopped) return;
    link.onState("connecting");
    const ws = open(link.url, [TAB_PROTOCOL, link.token]);
    socket = ws;
    ws.onopen = () => {
      delay = RETRY_MIN_MS;
      lastPong = Date.now();
      void hello();
      window.clearInterval(pingTimer);
      pingTimer = window.setInterval(() => {
        if (Date.now() - lastPong > DEAD_AFTER_MS) {
          ws.close();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(PING);
      }, PING_EVERY_MS);
    };
    ws.onmessage = (event) => {
      const data = String(event.data);
      if (data === PONG) {
        lastPong = Date.now();
        return;
      }
      void answer(ws, client, data);
    };
    ws.onclose = () => {
      window.clearInterval(pingTimer);
      if (socket === ws) socket = null;
      if (stopped) return;
      link.onState("retrying");
      retryTimer = window.setTimeout(connect, delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };
    ws.onerror = () => {
      // onclose follows.
    };
  };

  const hello = async () => {
    const ws = socket;
    if (!ws) return;
    const tools = await client.tools();
    if (ws !== socket || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "hello", tabId, tools, app: "web" } satisfies TabToRelay));
    link.onState("connected");
  };

  const onVisible = () => markActive();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", markActive);
  const onOnline = () => {
    if (!socket && !stopped) {
      window.clearTimeout(retryTimer);
      delay = RETRY_MIN_MS;
      connect();
    }
  };
  window.addEventListener("online", onOnline);
  connect();

  return () => {
    stopped = true;
    window.clearTimeout(retryTimer);
    window.clearInterval(pingTimer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", markActive);
    window.removeEventListener("online", onOnline);
    socket?.close();
    socket = null;
    link.onState("off");
  };
}

async function answer(ws: WebSocket, client: ToolClient, raw: string): Promise<void> {
  let message: RelayToTab;
  try {
    message = JSON.parse(raw) as RelayToTab;
  } catch {
    return;
  }
  if (message.type !== "call" || typeof message.id !== "string") return;
  let result: ReturnType<typeof mcpResult>;
  try {
    result = mcpResult(await client.call(message.name, message.args ?? {}));
  } catch (error) {
    result = mcpResult({
      ok: false,
      error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
    });
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "result", id: message.id, result } satisfies TabToRelay));
  }
}
