// CPU-side meshing benchmark: generates city fixtures and meshes every chunk on one thread.
// Run from web/: pnpm bench:mesh [cells ...] [--bits=5,6,7]
// GPU and frame-time numbers come from the in-app bench; this isolates the mesher.

import { chunkKeyToCoords, World } from "@voxyl/core";
import { generateCity } from "@voxyl/fixtures";
import { meshChunk, paddedVolume } from "../src/index.ts";

const args = process.argv.slice(2);
const bitsArg = args.find((a) => a.startsWith("--bits="));
const bitsList = bitsArg ? bitsArg.slice(7).split(",").map(Number) : [5, 6, 7];
const sizes = args.filter((a) => !a.startsWith("--")).map(Number);
const targets = sizes.length > 0 ? sizes : [1_000_000, 5_000_000];

const ms = (t: number) => `${t.toFixed(0)} ms`;
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

for (const target of targets) {
  for (const bits of bitsList) {
    const world = new World({ chunkBits: bits });
    let t = performance.now();
    generateCity(world, { targetCells: target, seed: 1 });
    const genMs = performance.now() - t;

    const copyTimes: number[] = [];
    const meshTimes: number[] = [];
    const cells = new Uint16Array(paddedVolume(bits));
    let quads = 0;
    t = performance.now();
    for (const key of world.chunkKeys()) {
      const [cx, cy, cz] = chunkKeyToCoords(key);
      let start = performance.now();
      world.copyPadded(cx, cy, cz, cells);
      copyTimes.push(performance.now() - start);
      start = performance.now();
      quads += meshChunk({ bits, cells, light: null, opaque: null }).quadCount;
      meshTimes.push(performance.now() - start);
    }
    const meshMs = performance.now() - t;
    copyTimes.sort((a, b) => a - b);
    meshTimes.sort((a, b) => a - b);
    const size = 1 << bits;
    const denseMb = (world.chunkCount * size ** 3 * 2) / 2 ** 20;
    console.log(
      [
        `${(world.cellCount / 1e6).toFixed(2)}M cells, ${size}^3 chunks:`,
        `generate ${ms(genMs)}`,
        `mesh all ${ms(meshMs)} (${world.chunkCount} chunks; per chunk copy p50 ${pct(copyTimes, 0.5).toFixed(2)} ms, mesh p50 ${pct(meshTimes, 0.5).toFixed(2)} ms, p95 ${pct(meshTimes, 0.95).toFixed(2)} ms)`,
        `${(quads / 1e6).toFixed(2)}M quads`,
        `storage ${(world.memoryBytes / 2 ** 20).toFixed(0)} MB (dense would be ${denseMb.toFixed(0)} MB)`,
      ].join(" | "),
    );
  }
}
