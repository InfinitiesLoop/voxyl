// Region stats, the text codec and rotate on the city (web-core.md step 7).
// Run from web/: node packages/fixtures/bench/reads.ts [cells] [--parts]

import {
  type Command,
  Project,
  parseRegionText,
  type Region,
  regionStats,
  regionText,
} from "@voxyl/core";
import { generateCity } from "../src/index.ts";

const target = Number(process.argv[2] ?? 5_000_000);
const parts = process.argv.includes("--parts");
let n = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `r${n++}`, kind, args });

function time<T>(label: string, run: () => T): T {
  const start = performance.now();
  const out = run();
  console.log(`${label}: ${(performance.now() - start).toFixed(0)} ms`);
  return out;
}

const project = new Project({ chunkBits: 6 });
generateCity(project, { targetCells: target, seed: 1, parts });
console.log(`city: ${project.world.cellCount} cells${parts ? ", shaped" : ""}`);

const all = time("stats, whole build", () => regionStats(project));
console.log(`  ${all.blocks.length} semantics, ${all.parts.length} part kinds, ${all.cells} cells`);
time("stats, 200x60x200 box", () => regionStats(project, { box: [0, 0, 0, 199, 59, 199] }));
const first = all.blocks[0]?.semantic ?? 1;
time("stats, one semantic over the whole build", () => regionStats(project, { semantic: first }));

for (const [w, h] of [
  [32, 16],
  [64, 32],
] as const) {
  const where: Region = { box: [0, 0, 0, w - 1, h - 1, w - 1] };
  const text = time(`text of ${w}x${h}x${w}`, () => regionText(project, where));
  const chars = JSON.stringify(text).length;
  console.log(
    `  ${(chars / 1024).toFixed(1)} KB of JSON, ${Object.keys(text.legend).length} legend entries`,
  );
  const args = time("  parsed back", () => parseRegionText(project, text));
  const r = time("  applied as a set command", () => project.run(cmd("set", args)));
  console.log(`  changed ${r.report.cells} cells (0 expected: same build)`);
}

const r = time("rotate 256x64x256 about up", () =>
  project.run(cmd("rotate", { where: { box: [0, 0, 0, 255, 63, 255] }, face: "up" })),
);
console.log(`  ${JSON.stringify(r.report.notes)}`);
