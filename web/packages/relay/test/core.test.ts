import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleMcpBody,
  looksLikeToken,
  mintToken,
  NO_TAB_MESSAGE,
  needsBackend,
  RelayCore,
  type TabLink,
  type ToolSpec,
  type ToolStore,
  verifyToken,
} from "../src/index.ts";

const TOOLS: ToolSpec[] = [{ name: "status" }];

class FakeTab implements TabLink {
  readonly sent: Record<string, unknown>[] = [];
  broken = false;
  send(text: string): void {
    if (this.broken) throw new Error("socket closed");
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
}

function memoryStore(initial: ToolSpec[] | null = null): ToolStore & { saves: number } {
  let tools = initial;
  const store = {
    saves: 0,
    load: async () => tools,
    save: async (next: readonly ToolSpec[]) => {
      store.saves++;
      tools = [...next];
    },
  };
  return store;
}

function relay(options: { store?: ToolStore; timeoutMs?: number; maxTabs?: number } = {}) {
  let clock = 1000;
  const core = new RelayCore({
    store: options.store ?? memoryStore(),
    now: () => ++clock,
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    ...(options.maxTabs !== undefined && { maxTabs: options.maxTabs }),
  });
  return core;
}

const hello = (tabId: string, tools: ToolSpec[] = TOOLS) =>
  JSON.stringify({ type: "hello", tabId, tools });

const ok = (text: string) => ({ content: [{ type: "text", text }], isError: false });

afterEach(() => {
  vi.useRealTimers();
});

describe("RelayCore routing", () => {
  it("fails a call with the actionable message when no tab is attached", async () => {
    const core = relay();
    await expect(core.call("status", {})).rejects.toMatchObject({
      code: "no_editor",
      message: NO_TAB_MESSAGE,
    });
  });

  it("sends a call to the tab and resolves with its result", async () => {
    const core = relay();
    const tab = new FakeTab();
    core.attach("a", tab);
    const result = core.call("status", { x: 1 });
    expect(tab.sent).toEqual([{ type: "call", id: "c1", name: "status", args: { x: 1 } }]);
    await core.onMessage("a", JSON.stringify({ type: "result", id: "c1", result: ok("hi") }));
    await expect(result).resolves.toEqual(ok("hi"));
  });

  it("routes to the tab used last, and follows the user between tabs", async () => {
    const core = relay();
    const a = new FakeTab();
    const b = new FakeTab();
    core.attach("a", a);
    core.attach("b", b);
    expect(core.activeTab).toBe("b");
    await core.onMessage("a", JSON.stringify({ type: "active" }));
    expect(core.activeTab).toBe("a");
    void core.call("status", {}).catch(() => undefined);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it("falls back to the other tab when the active one goes away", async () => {
    const core = relay();
    const a = new FakeTab();
    const b = new FakeTab();
    core.attach("a", a);
    core.attach("b", b);
    core.detach("b");
    void core.call("status", {}).catch(() => undefined);
    expect(a.sent).toHaveLength(1);
  });

  it("fails the calls a tab still owed when it closes, and not the others", async () => {
    const core = relay();
    core.attach("a", new FakeTab());
    const owed = core.call("fill", {});
    core.detach("a");
    await expect(owed).rejects.toMatchObject({ code: "tab_closed" });
  });

  it("ignores a result from a tab that was not asked", async () => {
    const core = relay();
    core.attach("a", new FakeTab());
    core.attach("b", new FakeTab());
    await core.onMessage("a", JSON.stringify({ type: "active" }));
    const call = core.call("status", {});
    await core.onMessage("b", JSON.stringify({ type: "result", id: "c1", result: ok("forged") }));
    await core.onMessage("a", JSON.stringify({ type: "result", id: "c1", result: ok("real") }));
    await expect(call).resolves.toEqual(ok("real"));
  });

  it("times out a call the tab never answers", async () => {
    vi.useFakeTimers();
    const core = relay({ timeoutMs: 5000 });
    core.attach("a", new FakeTab());
    const call = core.call("status", {});
    const settled = expect(call).rejects.toMatchObject({ code: "editor_timeout" });
    await vi.advanceTimersByTimeAsync(5001);
    await settled;
  });

  it("drops a tab whose socket throws on send, and says so", async () => {
    const core = relay();
    const tab = new FakeTab();
    tab.broken = true;
    core.attach("a", tab);
    await expect(core.call("status", {})).rejects.toMatchObject({ code: "tab_gone" });
    expect(core.tabCount).toBe(0);
  });

  it("limits calls in flight", async () => {
    const core = new RelayCore({ store: memoryStore(), maxPending: 2 });
    core.attach("a", new FakeTab());
    void core.call("a", {}).catch(() => undefined);
    void core.call("b", {}).catch(() => undefined);
    await expect(core.call("c", {})).rejects.toMatchObject({ code: "busy" });
  });

  it("holds at most maxTabs, dropping the least recently used", () => {
    const core = relay({ maxTabs: 2 });
    expect(core.attach("a", new FakeTab())).toEqual([]);
    expect(core.attach("b", new FakeTab())).toEqual([]);
    expect(core.attach("c", new FakeTab())).toEqual(["a"]);
  });
});

describe("RelayCore tool list", () => {
  it("caches the list from hello, stores it once, and serves it with no tab", async () => {
    const store = memoryStore();
    const core = relay({ store });
    core.attach("a", new FakeTab());
    await core.onMessage("a", hello("a"));
    await core.onMessage("a", hello("a"));
    expect(store.saves).toBe(1);
    core.detach("a");
    expect(await core.tools()).toEqual(TOOLS);
  });

  it("serves the stored list after the object restarts", async () => {
    const core = relay({ store: memoryStore(TOOLS) });
    expect(await core.tools()).toEqual(TOOLS);
  });

  it("does not rewrite storage when a restarted object sees the same list", async () => {
    const store = memoryStore(TOOLS);
    const core = relay({ store });
    core.attach("a", new FakeTab());
    await core.onMessage("a", hello("a"));
    expect(store.saves).toBe(0);
  });

  it("is empty before any tab ever connected", async () => {
    expect(await relay().tools()).toEqual([]);
  });

  it("ignores frames that are not valid", async () => {
    const core = relay();
    core.attach("a", new FakeTab());
    await expect(core.onMessage("a", "not json")).resolves.toEqual({});
    await expect(core.onMessage("a", JSON.stringify({ type: "hello" }))).resolves.toEqual({});
  });
});

describe("handleMcpBody", () => {
  it("answers initialize and ping without the backend's help", async () => {
    const core = relay();
    const init = await handleMcpBody(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      core,
    );
    expect(init.body).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-03-26", serverInfo: { name: "voxyl" } },
    });
    expect((await handleMcpBody({ jsonrpc: "2.0", id: 2, method: "ping" }, core)).body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });
  });

  it("answers a notification with 202 and nothing else", async () => {
    const reply = await handleMcpBody(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      relay(),
    );
    expect(reply).toEqual({ status: 202 });
  });

  it("turns a relay failure into a tool error the model can read", async () => {
    const reply = await handleMcpBody(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
      relay(),
    );
    const result = (reply.body as { result: { isError: boolean; content: { text: string }[] } })
      .result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "no_editor" },
    });
  });

  it("handles a batch and reports unknown methods", async () => {
    const reply = await handleMcpBody(
      [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "nope" },
      ],
      relay(),
    );
    expect(reply.body).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: nope" } },
    ]);
  });

  it("knows which bodies need the backend", () => {
    expect(needsBackend({ method: "initialize" })).toBe(false);
    expect(needsBackend([{ method: "ping" }, { method: "tools/call" }])).toBe(true);
    expect(needsBackend({ method: "tools/list" })).toBe(true);
  });
});

describe("tokens", () => {
  it("verifies what it minted and returns the id", async () => {
    const token = await mintToken("secret");
    expect(looksLikeToken(token)).toBe(true);
    const id = await verifyToken("secret", token);
    expect(id).toBe(token.split(".")[1]);
  });

  it("refuses another secret, a changed id or signature, and junk", async () => {
    const token = await mintToken("secret");
    const [prefix, id, signature] = token.split(".") as [string, string, string];
    expect(await verifyToken("other", token)).toBeNull();
    const otherId = (await mintToken("secret")).split(".")[1];
    expect(await verifyToken("secret", `${prefix}.${otherId}.${signature}`)).toBeNull();
    expect(await verifyToken("secret", `${prefix}.${id}.${signature.slice(1)}A`)).toBeNull();
    expect(await verifyToken("secret", "hello")).toBeNull();
    expect(await verifyToken("secret", "vx1.a.b")).toBeNull();
    expect(await verifyToken("secret", "")).toBeNull();
  });

  it("mints different tokens each time", async () => {
    expect(await mintToken("s")).not.toBe(await mintToken("s"));
  });
});
