// Connects this tab to the local MCP bridge (web/tools/bridge.ts) so Claude Code, on this
// machine, can call the same tools the page offers. Dev only: a production page does not
// talk to localhost. If the bridge is not running, it retries quietly.

import type { ToolClient } from "./webmcp.ts";
import { mcpResult } from "./webmcp.ts";

const DEFAULT_URL = "ws://127.0.0.1:47824/tab";

/** Opens the socket and keeps it open. Returns a function that stops retrying and closes it. */
export function connectBridge(client: ToolClient, url = DEFAULT_URL): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry = 0;

  const open = () => {
    if (stopped) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onmessage = (event) => {
      void answer(ws, client, String(event.data));
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (!stopped) retry = window.setTimeout(open, 2000);
    };
    ws.onerror = () => {
      // onclose follows; the bridge may simply not be running.
    };
  };
  open();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    socket?.close();
    socket = null;
  };
}

async function answer(ws: WebSocket, client: ToolClient, raw: string): Promise<void> {
  let message: { type?: string; id?: string; name?: string; args?: unknown };
  try {
    message = JSON.parse(raw) as typeof message;
  } catch {
    return;
  }
  if (ws.readyState !== WebSocket.OPEN || message.id === undefined) return;
  if (message.type === "list") {
    const tools = await client.tools();
    ws.send(JSON.stringify({ type: "list", id: message.id, tools }));
    return;
  }
  if (message.type === "call" && message.name) {
    try {
      const envelope = await client.call(message.name, message.args ?? {});
      ws.send(JSON.stringify({ type: "result", id: message.id, result: mcpResult(envelope) }));
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "result",
          id: message.id,
          result: mcpResult({
            ok: false,
            error: {
              code: "internal",
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        }),
      );
    }
  }
}
