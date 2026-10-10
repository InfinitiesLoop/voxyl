// The whole production path with a real editor tab: a headless browser opens the app, the
// user's clicks (Home, Agents, "Let agents use this editor") turn access on, and this script
// then plays the agent over MCP HTTP, with the token it reads back from the page.
//
//   node tools/relay-e2e.ts                       # dev app on :5173 and a local relay on :47826
//   node tools/relay-e2e.ts --app https://voxyl.xyz --relay https://api.voxyl.xyz
//
// The app must be built to talk to that relay (a dev server uses :47826, production uses
// api.voxyl.xyz). It makes a project named "relay e2e" in the throwaway browser profile only.

import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const app = option("app", "http://localhost:5173");
const relay = option("relay", "http://127.0.0.1:47826");
const channel = option("channel", process.platform === "win32" ? "msedge" : "chrome");

type Json = Record<string, unknown>;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  const more = ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${more}`);
}

let token = "";
let nextId = 1;
async function rpc(method: string, params: Json = {}): Promise<Json> {
  const response = await fetch(`${relay}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return (await response.json()) as Json;
}
async function tool(name: string, args: Json = {}): Promise<{ isError: boolean; data: Json }> {
  const reply = await rpc("tools/call", { name, arguments: args });
  const result = reply.result as { isError: boolean; content: { type: string; text?: string }[] };
  if (!result) return { isError: true, data: reply };
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError, data: JSON.parse(text) as Json };
}

const browser = await chromium.launch({
  channel,
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto(app);
  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Let agents use this editor" }).click();
  await page.getByText("On. Agents can use this editor").waitFor({ timeout: 20_000 });
  check("the Agents tab turns on and connects", true);

  token = await page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem("voxyl.agent") ?? "{}") as { token?: string }).token ?? "",
  );
  check("a token was minted and kept", token.startsWith("vx1."), token.slice(0, 8));

  const list = await rpc("tools/list");
  const tools = ((list.result as Json | undefined)?.tools ?? []) as { name: string }[];
  console.log(`    tool list: ${tools.length} tools, ${JSON.stringify(list).length} bytes`);
  check("tools/list serves the editor's tools", tools.length > 30, tools.length);
  check(
    "the list has data tools and view tools",
    tools.some((t) => t.name === "fill") && tools.some((t) => t.name === "view_set"),
  );

  const created = await tool("project_create", { name: "relay e2e" });
  check("project_create runs in the tab", !created.isError, created.data);
  await tool("palette_edit", {
    palette: "Main",
    create: {},
    ops: [{ op: "add", semantic: "Wall", block: "voxyl:stone" }],
  });
  const filled = await tool("fill", { where: { box: [0, 0, 0, 3, 3, 3] }, semantic: "Wall" });
  check("fill edits the build", !filled.isError && filled.data.ok === true, filled.data);
  const status = await tool("status");
  check(
    "status sees the edit and an attached editor",
    JSON.stringify(status.data).includes("relay e2e"),
    status.data,
  );

  // The same edit is on screen: ask the page's own worker, not the relay.
  const viaPage = await page.evaluate(async () => {
    const tools = (window as { voxylTools?: { call(n: string, a: unknown): Promise<unknown> } })
      .voxylTools;
    return JSON.stringify(await tools?.call("inspect", { view: "summary" }));
  });
  check("the page's own view of the build has the 64 cells", viaPage.includes("64"), viaPage);

  const shot = await rpc("tools/call", { name: "capture", arguments: {} });
  const images = (
    (shot.result as { content?: { type: string }[] } | undefined)?.content ?? []
  ).filter((c) => c.type === "image");
  check("capture returns a picture from the tab's renderer", images.length > 0, shot);

  // Reload: the tab reconnects by itself, with no clicks.
  await page.reload();
  await page
    .getByText("On. Agents can use this editor")
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterReload = await tool("status");
  check("after a reload the tab reconnects on its own", afterReload.data.ok === true, afterReload);

  // Close the tab: calls fail with the actionable message.
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const gone = await tool("status");
  check(
    "with the tab closed, a call says to open the editor",
    gone.isError && JSON.stringify(gone.data).includes("no_editor"),
    gone.data,
  );
  const listed = await rpc("tools/list");
  check(
    "and the tool list is still served",
    (((listed.result as Json | undefined)?.tools ?? []) as unknown[]).length > 30,
  );
  const real = problems.filter((p) => !/favicon|Failed to load resource.*404/.test(p));
  check("no console errors", real.length === 0, real);
} finally {
  await browser.close();
}
console.log(failures === 0 ? "\nAll good." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
