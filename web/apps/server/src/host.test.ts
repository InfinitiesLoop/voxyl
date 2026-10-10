import { afterEach, describe, expect, it } from "vitest";
import { type Headless, startHost } from "./host.ts";

const hosts: Headless[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
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

function call(port: number, id: number, name: string, args: unknown = {}) {
  return post(port, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

/** The envelope a tool returned, from the text block of an MCP result. */
function envelope(body: Record<string, unknown>): Record<string, unknown> {
  const result = body.result as { content?: { text?: string }[] };
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`no text result: ${JSON.stringify(body)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("headless host", () => {
  it("lists the data tools and says no editor is attached", async () => {
    const host = await startHost({ port: 0 });
    hosts.push(host);
    const init = await post(host.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({
      id: 1,
      result: {
        serverInfo: { name: "voxyl" },
        protocolVersion: "2025-06-18",
        instructions: expect.stringContaining("no editor tab"),
      },
    });
    const listed = await post(host.port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (listed.body.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toContain("status");
    expect(tools).toContain("fill");
    expect(tools).not.toContain("view_set");
    const stream = await fetch(`http://127.0.0.1:${host.port}/mcp`);
    expect(stream.status).toBe(405);
    const status = envelope((await call(host.port, 3, "status")).body);
    expect(status).toMatchObject({
      ok: true,
      editor_attached: false,
      project: { name: "Untitled", cells: 0 },
    });
  });

  it("applies an edit in this process, and a repeat does not apply twice", async () => {
    const host = await startHost({ port: 0 });
    hosts.push(host);
    const made = envelope(
      (
        await call(host.port, 1, "palette_edit", {
          palette: "Main",
          ops: [{ op: "add", semantic: "Mass", block: "voxyl:stone" }],
        })
      ).body,
    );
    expect(made).toMatchObject({ ok: true, ops_applied: 1 });
    const filled = envelope(
      (
        await call(host.port, 2, "fill", {
          where: { box: [0, 0, 0, 1, 0, 1] },
          semantic: "Mass",
          op_id: "once",
        })
      ).body,
    );
    expect(filled).toMatchObject({ ok: true, changed: 4 });
    expect(host.memory.project?.world.cellCount).toBe(4);
    const again = envelope(
      (
        await call(host.port, 3, "fill", {
          where: { box: [0, 0, 0, 1, 0, 1] },
          semantic: "Mass",
          op_id: "once",
        })
      ).body,
    );
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(host.memory.project?.world.cellCount).toBe(4);
    const seen = envelope((await call(host.port, 4, "inspect", { view: "summary" })).body);
    expect(seen).toMatchObject({ ok: true, cells: 4 });
  });

  it("refuses a capture, which needs an editor to render", async () => {
    const host = await startHost({ port: 0 });
    hosts.push(host);
    await call(host.port, 1, "palette_edit", {
      palette: "Main",
      ops: [{ op: "add", semantic: "Mass" }],
    });
    await call(host.port, 2, "fill", {
      where: { box: [0, 0, 0, 0, 0, 0] },
      semantic: "Mass",
    });
    const shot = await call(host.port, 3, "capture", {});
    expect(shot.body).toMatchObject({ result: { isError: true } });
    expect(envelope(shot.body)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});
