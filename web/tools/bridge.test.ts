import { afterEach, describe, expect, it } from "vitest";
import { type Bridge, startBridge } from "./bridge.ts";

const bridges: Bridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function post(
  port: number,
  message: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("local bridge", () => {
  it("answers initialize without a tab, and refuses a tool call until one connects", async () => {
    const bridge = await startBridge({ port: 0, quiet: true });
    bridges.push(bridge);
    const init = await post(bridge.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "voxyl" }, protocolVersion: "2025-06-18" },
    });
    const missing = await post(bridge.port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(missing.body).toMatchObject({
      id: 2,
      error: { message: expect.stringContaining("No Voxyl tab") },
    });
  });

  it("forwards tools/list and tools/call to the connected tab", async () => {
    const bridge = await startBridge({ port: 0, quiet: true });
    bridges.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/tab`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("socket failed")));
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; id: string; name?: string };
      if (message.type === "list") {
        ws.send(
          JSON.stringify({
            type: "list",
            id: message.id,
            tools: [{ name: "status", description: "Status", inputSchema: { type: "object" } }],
          }),
        );
      } else if (message.type === "call") {
        ws.send(
          JSON.stringify({
            type: "result",
            id: message.id,
            result: { content: [{ type: "text", text: message.name }], isError: false },
          }),
        );
      }
    });
    const listed = await post(bridge.port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });
    expect(listed.body).toMatchObject({
      result: { tools: [{ name: "status" }] },
    });
    const called = await post(bridge.port, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    expect(called.body).toMatchObject({
      result: { content: [{ type: "text", text: "status" }], isError: false },
    });
    ws.close();
  });
});
