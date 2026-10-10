// The wire between the relay and an editor tab. JSON text frames over one WebSocket.
//
// The tab speaks first (`hello`). After that the relay sends `call`s and the tab answers each
// with a `result` carrying the call's id. The literal text "ping" is a keepalive: the Durable
// Object answers "pong" without waking (setWebSocketAutoResponse), so an idle socket costs
// nothing.

/** A tool as the tab lists it (what MCP's tools/list returns). */
export interface ToolSpec {
  readonly name: string;
}

/** The MCP tool result a tab produces: text and image blocks plus isError. */
export interface McpToolResult {
  readonly [key: string]: unknown;
  readonly content: readonly unknown[];
  readonly isError?: boolean;
}

export type TabToRelay =
  | {
      readonly type: "hello";
      /** Random per tab; the relay keys a tab by it. */
      readonly tabId: string;
      readonly tools: readonly ToolSpec[];
      /** Free text for logs and errors: the app version. */
      readonly app?: string;
    }
  /** The tab became the one the user is looking at. */
  | { readonly type: "active" }
  | { readonly type: "result"; readonly id: string; readonly result: McpToolResult };

export type RelayToTab = {
  readonly type: "call";
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
};

/** The WebSocket subprotocol a tab offers first; the token follows as the second. */
export const TAB_PROTOCOL = "voxyl.v1";

export const PING = "ping";
export const PONG = "pong";

/** How often a tab pings, and how long without a pong before it reconnects. */
export const PING_EVERY_MS = 30_000;
export const DEAD_AFTER_MS = 75_000;

export function parseTabMessage(text: string): TabToRelay | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "hello":
      if (typeof message.tabId !== "string" || message.tabId === "" || message.tabId.length > 64)
        return null;
      if (!Array.isArray(message.tools)) return null;
      return {
        type: "hello",
        tabId: message.tabId,
        tools: message.tools as ToolSpec[],
        ...(typeof message.app === "string" && { app: message.app.slice(0, 64) }),
      };
    case "active":
      return { type: "active" };
    case "result":
      if (typeof message.id !== "string") return null;
      if (typeof message.result !== "object" || message.result === null) return null;
      return { type: "result", id: message.id, result: message.result as McpToolResult };
    default:
      return null;
  }
}
