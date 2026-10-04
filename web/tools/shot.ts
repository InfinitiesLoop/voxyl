// Opens the app in a headless browser, waits for the world to mesh, and reports what it sees:
// console errors, the HUD, the number of canvases, and a screenshot. With --bench it also runs
// the in-app benchmark and prints the JSON. Points at the dev server by default, so it checks
// exactly what `pnpm dev` serves (including React's development double mount).
//
//   pnpm shot                         # http://localhost:5173, default world
//   pnpm shot "world=city-5m&lighting=volume" --bench
//   pnpm shot --url http://localhost:4173 --out shots/preview.png
//   pnpm shot "world=city-1m" --timeout 30   # seconds to wait for meshing (default 180)
//
// Uses the installed Edge or Chrome (playwright-core downloads no browsers).

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const valued = new Set(["--url", "--out", "--channel", "--timeout"]);
const query = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? "")) ?? "";
const base = option("url", "http://localhost:5173");
const out = resolve(option("out", "shots/latest.png"));
const channel = option("channel", process.platform === "win32" ? "msedge" : "chrome");

const browser = await chromium.launch({
  channel,
  headless: !flag("headed"),
  args: ["--enable-unsafe-webgpu"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
  const url = query ? `${base}/?${query}` : base;
  await page.goto(url);
  // Ready once the world is meshed and no banner (generating, lighting) is up. If that never
  // happens, still report what the page shows: the console usually says why.
  const ready = await page
    .waitForFunction(
      () =>
        !document.querySelector(".banner") &&
        /initial mesh \d/.test(document.querySelector(".hud")?.textContent ?? ""),
      null,
      { timeout: Number(option("timeout", "180")) * 1000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!ready) problems.push("[shot] the world never finished meshing; showing it as it is");
  await page.waitForTimeout(1000);
  const canvases = await page.evaluate(() => document.querySelectorAll(".viewport canvas").length);
  const hud = (await page.textContent(".hud"))?.replace(/\s+/g, " ") ?? "";
  console.log(`url: ${url}`);
  console.log(`canvases: ${canvases}${canvases === 1 ? "" : "  <-- expected 1"}`);
  console.log(`hud: ${hud}`);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`screenshot: ${out}`);
  if (ready && flag("bench")) {
    await page.click("text=Run benchmark");
    await page.waitForFunction(() => "__voxylBench" in window, null, { timeout: 600_000 });
    console.log(
      JSON.stringify(
        await page.evaluate(() => (window as { __voxylBench?: unknown }).__voxylBench),
        null,
        1,
      ),
    );
    await page.screenshot({ path: out.replace(/\.png$/, "-bench.png") });
  }
  // The same error usually repeats every frame: list each once, with a count.
  const counts = new Map<string, number>();
  for (const p of problems) counts.set(p, (counts.get(p) ?? 0) + 1);
  const listed = [...counts].map(([p, n]) => (n > 1 ? `${p} (x${n})` : p));
  console.log(listed.length ? `problems:\n  ${listed.join("\n  ")}` : "problems: none");
} finally {
  await browser.close();
}
