// Opens the app in a headless browser, waits for the world to mesh, and reports what it sees:
// console errors, the HUD, the number of canvases, and a screenshot. With --bench it also runs
// the in-app benchmark and prints the JSON. Points at the dev server by default, so it checks
// exactly what `pnpm dev` serves (including React's development double mount).
//
//   pnpm shot                         # http://localhost:5173, default world
//   pnpm shot "world=city-5m&lighting=on" --bench
//   pnpm shot --url http://localhost:4173 --out shots/preview.png
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
const valued = new Set(["--url", "--out", "--channel"]);
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
  // Ready once the world is meshed and no banner (generating, lighting) is up.
  await page.waitForFunction(
    () =>
      !document.querySelector(".banner") &&
      /initial mesh \d/.test(document.querySelector(".hud")?.textContent ?? ""),
    null,
    { timeout: 180_000 },
  );
  await page.waitForTimeout(1000);
  const canvases = await page.evaluate(() => document.querySelectorAll(".viewport canvas").length);
  const hud = (await page.textContent(".hud"))?.replace(/\s+/g, " ") ?? "";
  console.log(`url: ${url}`);
  console.log(`canvases: ${canvases}${canvases === 1 ? "" : "  <-- expected 1"}`);
  console.log(`hud: ${hud}`);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`screenshot: ${out}`);
  if (flag("bench")) {
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
  console.log(problems.length ? `problems:\n  ${problems.join("\n  ")}` : "problems: none");
} finally {
  await browser.close();
}
