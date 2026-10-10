// End-to-end check of a running relay, local or deployed, with a fake tab standing in for the
// editor. It proves the whole path an agent takes: mint a token, connect a tab, list tools,
// call one (the fake tab answers), lose the tab, and get the "open the editor" error.
//
//   node tools/relay-smoke.ts [--url http://127.0.0.1:47826]
//   node tools/relay-smoke.ts --url https://api.voxyl.xyz
//   node tools/relay-smoke.ts --idle 25      # also let the object hibernate before calling
//
// It mints a token of its own, so it touches nothing of yours.

import { PING, PONG, TAB_PROTOCOL } from "@voxyl/relay";

const arg = process.argv.indexOf("--url");
const idleArg = process.argv.indexOf("--idle");
// Seconds to leave the tab connected and silent before calling: long enough for the Durable
// Object to hibernate (about 10 s in production), to prove a call wakes it and finds the tab.
const idleSeconds = idleArg > 0 ? Number(process.argv[idleArg + 1]) : 0;
const base = (arg > 0 ? process.argv[arg + 1] : "http://127.0.0.1:47826") as string;
const wsBase = base.replace(/^http/, "ws");

type Json = Record<string, unknown>;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`,
  );
}

async function rpc(token: string, id: number, method: string, params: Json = {}): Promise<Json> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await response.json()) as Json;
}

function openTab(token: string, tabId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/tab`, [TAB_PROTOCOL, token]);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          tabId,
          tools: [{ name: "status", description: "state", inputSchema: { type: "object" } }],
        }),
      );
      resolve(ws);
    });
    ws.addEventListener("error", () => reject(new Error("tab socket failed")));
  });
}

const minted = await fetch(`${base}/api/token`, { method: "POST" });
const token = ((await minted.json()) as { token?: string }).token ?? "";
check("mints a token", /^vx1\./.test(token), token);

const bad = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: "Bearer vx1.bad.bad", "content-type": "application/json" },
  body: "{}",
});
check("refuses a bad token with 401", bad.status === 401, bad.status);

const init = await rpc(token, 1, "initialize", { protocolVersion: "2025-06-18" });
check("initialize", (init.result as Json | undefined)?.serverInfo !== undefined, init);

const noTab = await rpc(token, 2, "tools/call", { name: "status", arguments: {} });
check(
  "a call with no tab says to open the editor",
  JSON.stringify(noTab).includes("no_editor"),
  noTab,
);

const tab = await openTab(token, "smoke-tab");
tab.addEventListener("message", (event) => {
  if (String(event.data) === PONG) return;
  const message = JSON.parse(String(event.data)) as Json;
  if (message.type !== "call") return;
  tab.send(
    JSON.stringify({
      type: "result",
      id: message.id,
      result: { content: [{ type: "text", text: `ran ${message.name}` }], isError: false },
    }),
  );
});
await new Promise((resolve) => setTimeout(resolve, 500 + idleSeconds * 1000));

const list = await rpc(token, 3, "tools/list");
const tools = ((list.result as Json | undefined)?.tools ?? []) as Json[];
check("tools/list serves the tab's tools", tools[0]?.name === "status", list);

const call = await rpc(token, 4, "tools/call", { name: "status", arguments: {} });
check("a call reaches the tab and comes back", JSON.stringify(call).includes("ran status"), call);

const pong = await new Promise<string>((resolve) => {
  const listener = (event: MessageEvent) => {
    if (String(event.data) === PONG) {
      tab.removeEventListener("message", listener);
      resolve(PONG);
    }
  };
  tab.addEventListener("message", listener);
  tab.send(PING);
  setTimeout(() => resolve("none"), 3000);
});
check("ping is answered with pong", pong === PONG, pong);

const viaPath = await fetch(`${base}/mcp/${token}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
});
check("the token also works in the URL path", viaPath.status === 200, viaPath.status);

tab.close();
await new Promise((resolve) => setTimeout(resolve, 800));
const afterClose = await rpc(token, 6, "tools/call", { name: "status", arguments: {} });
check("after the tab closes, calls fail clearly", JSON.stringify(afterClose).includes("no_editor"));
const stillListed = await rpc(token, 7, "tools/list");
check(
  "tools/list still works with no tab",
  (((stillListed.result as Json | undefined)?.tools ?? []) as Json[]).length === 1,
  stillListed,
);

console.log(failures === 0 ? "\nAll good." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
