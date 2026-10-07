// Golden images: renders a fixed set of scenes and compares each with the image committed in
// golden/. Rendering runs on SwiftShader, Chrome's CPU implementation of WebGPU, so images
// don't depend on the machine's GPU or driver. Points at the dev server, like `pnpm shot`.
//
//   pnpm golden                 # compare; differences are written to shots/golden/
//   pnpm golden --update        # write the current renders as the new golden images
//   pnpm golden sky-dawn        # only scenes whose name contains this
//   pnpm golden --url http://localhost:5174
//   pnpm golden --gpu           # render on this machine's GPU instead (to tell SwiftShader
//                               # quirks from real problems); writes to shots/golden/gpu/
//
// A scene fails when more than MAX_DIFF_RATIO of its pixels differ by more than
// PIXEL_TOLERANCE in any channel (antialiasing and float rounding move a few edge pixels).
// The ratio is tight on purpose: a one-pixel line across the sky is about 0.06% of an image.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const WIDTH = 640;
const HEIGHT = 360;
const PIXEL_TOLERANCE = 24;
const MAX_DIFF_RATIO = 0.0002;

type V3 = readonly [number, number, number];

interface Scene {
  readonly name: string;
  /** The app's query string. */
  readonly query: string;
  /** Camera position and target; omitted, the world's home view. */
  readonly pose?: { readonly at: V3; readonly look: V3 };
  /** Which canvas to capture: the 3D view (default) or the 2D view. */
  readonly view?: "3d" | "2d";
}

const SCENES: readonly Scene[] = [
  { name: "blocks-overview", query: "world=blocks&time=12" },
  {
    // Fences turning a corner into stone, panes in a frame, slabs on both halves.
    name: "blocks-models",
    query: "world=blocks&time=12",
    pose: { at: [11, 6, 41], look: [11, 1.5, 31] },
  },
  {
    // Stairs each way and upside down, logs on each axis, glass in front of a wall.
    name: "blocks-orientations",
    query: "world=blocks&time=12",
    pose: { at: [10, 7, 8], look: [10, 1, 20] },
  },
  {
    // The glowstone room at night, light spilling out of its door onto the lawn.
    name: "blocks-night-lamp",
    query: "world=blocks&time=21&lighting=volume",
    pose: { at: [12, 9, 35], look: [12, 2.5, 25] },
  },
  { name: "city-concrete", query: "world=city-1m&theme=concrete&lighting=volume&time=12" },
  {
    name: "city-blocks-street",
    query: "world=city-1m&theme=blocks&lighting=volume&time=12",
    pose: { at: [40, 30, 40], look: [120, 10, 120] },
  },
  {
    name: "parts-close",
    query: "world=parts-1m&theme=concrete&lighting=volume&time=12",
    pose: { at: [60, 24, 60], look: [90, 12, 90] },
  },
  {
    // Dawn in the project's east, the rings across the south.
    name: "sky-dawn",
    query: "world=pillar&time=6",
    pose: { at: [0, 20, 0], look: [100, 30, 0] },
  },
  {
    name: "sky-night-rings",
    query: "world=pillar&time=22",
    pose: { at: [0, 20, 0], look: [0, 60, 100] },
  },
  { name: "grid-plan", query: "world=blocks&time=12&views=split", view: "2d" },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const valued = new Set(["--url", "--channel"]);
const filter = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? "")) ?? "";
const base = option("url", "http://localhost:5173");
const channel = option("channel", process.platform === "win32" ? "msedge" : "chrome");
const gpu = flag("gpu");
const update = flag("update") && !gpu;
const goldenDir = resolve("golden");
const outDir = resolve(gpu ? "shots/golden/gpu" : "shots/golden");
mkdirSync(outDir, { recursive: true });
mkdirSync(goldenDir, { recursive: true });

const browser = await chromium.launch({
  channel,
  headless: true,
  // SwiftShader's WebGPU adapter in place of the GPU, for the same pixels on any machine.
  args: gpu
    ? ["--enable-unsafe-webgpu"]
    : ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-unsafe-swiftshader"],
});
let failed = 0;
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  for (const scene of SCENES.filter((s) => s.name.includes(filter))) {
    const start = Date.now();
    const problems: string[] = [];
    const onConsole = (m: { type(): string; text(): string }) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    };
    page.on("console", onConsole);
    const png = await render(page, scene);
    page.off("console", onConsole);
    const file = resolve(goldenDir, `${scene.name}.png`);
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    const notes = problems.length > 0 ? `  console: ${[...new Set(problems)].join(" | ")}` : "";
    if (gpu) {
      writeFileSync(resolve(outDir, `${scene.name}.png`), png);
      console.log(`${scene.name}: rendered on the GPU (${seconds} s)${notes}`);
      continue;
    }
    if (update || !existsSync(file)) {
      writeFileSync(file, png);
      console.log(`${scene.name}: written (${seconds} s)${notes}`);
      continue;
    }
    const result = await compare(page, readFileSync(file), png);
    const ratio = result.differing / result.pixels;
    const ok = result.sameSize && ratio <= MAX_DIFF_RATIO;
    if (!ok) {
      failed++;
      writeFileSync(resolve(outDir, `${scene.name}.png`), png);
      if (result.diff) writeFileSync(resolve(outDir, `${scene.name}-diff.png`), result.diff);
    }
    const what = result.sameSize
      ? `${(ratio * 100).toFixed(3)}% of pixels differ`
      : "the image size changed";
    console.log(`${scene.name}: ${ok ? "ok" : "FAILED"}, ${what} (${seconds} s)${notes}`);
  }
} finally {
  await browser.close();
}
if (failed > 0) {
  console.log(`${failed} scene(s) differ: see ${outDir} (the render, and -diff in red)`);
  process.exitCode = 1;
}

/** Opens the scene, poses the camera, waits until everything is meshed and lit, captures. */
async function render(page: Page, scene: Scene): Promise<Buffer> {
  await page.goto(`${base}/?${scene.query}`);
  await page.waitForFunction(
    () =>
      !document.querySelector(".banner") &&
      /initial mesh \d/.test(document.querySelector(".hud")?.textContent ?? "") &&
      "__voxylEngine" in window,
    null,
    { timeout: 600_000 },
  );
  await page.addStyleTag({
    content: ".hud, .hint { display: none !important; }",
  });
  await page.evaluate(async (pose) => {
    const engine = (window as unknown as { __voxylEngine: EngineHandle }).__voxylEngine;
    if (pose) {
      const [x, y, z] = pose.at;
      const [tx, ty, tz] = pose.look;
      engine.fly.place({ x, y, z }, { x: tx, y: ty, z: tz });
    } else {
      engine.home();
    }
    // Let the camera reach the world worker, then wait for every mesh and light it causes.
    for (let i = 0; i < 4; i++) await engine.nextFrame();
    await engine.whenIdle();
    for (let i = 0; i < 4; i++) await engine.nextFrame();
  }, scene.pose ?? null);
  const selector = scene.view === "2d" ? ".grid-pane canvas" : ".viewport canvas";
  // The 2D view refetches its slice shortly after the world settles.
  if (scene.view === "2d") await page.waitForTimeout(500);
  return page.locator(selector).first().screenshot();
}

interface EngineHandle {
  fly: { place(at: { x: number; y: number; z: number }, look: typeof at): void };
  home(): void;
  nextFrame(): Promise<void>;
  whenIdle(): Promise<void>;
}

/** Compares two PNGs in the page (no image libraries here): counts differing pixels. */
async function compare(
  page: Page,
  expected: Buffer,
  actual: Buffer,
): Promise<{ sameSize: boolean; pixels: number; differing: number; diff: Buffer | null }> {
  const result = await page.evaluate(
    async ([a, b, tolerance]) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [want, got] = [await decode(a), await decode(b)];
      if (want.width !== got.width || want.height !== got.height)
        return { sameSize: false, pixels: 1, differing: 1, diff: null };
      // The diff: the expected image faded, with differing pixels in red.
      const out = new ImageData(want.width, want.height);
      let differing = 0;
      for (let i = 0; i < want.data.length; i += 4) {
        let worst = 0;
        for (let c = 0; c < 3; c++)
          worst = Math.max(worst, Math.abs((want.data[i + c] ?? 0) - (got.data[i + c] ?? 0)));
        const grey = ((want.data[i] ?? 0) + (want.data[i + 1] ?? 0) + (want.data[i + 2] ?? 0)) / 9;
        const bad = worst > tolerance;
        if (bad) differing++;
        out.data.set(bad ? [255, 0, 0, 255] : [grey + 170, grey + 170, grey + 170, 255], i);
      }
      const canvas = new OffscreenCanvas(want.width, want.height);
      (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(out, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const diffBytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of diffBytes) binary += String.fromCharCode(byte);
      return {
        sameSize: true,
        pixels: want.width * want.height,
        differing,
        diff: differing > 0 ? btoa(binary) : null,
      };
    },
    [expected.toString("base64"), actual.toString("base64"), PIXEL_TOLERANCE] as const,
  );
  return { ...result, diff: result.diff ? Buffer.from(result.diff, "base64") : null };
}
