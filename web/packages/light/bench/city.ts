// Light engine benchmark on the city fixtures, on one thread.
// Run from web/: pnpm bench:light [cells ...] [--bits=6]

import { chunkKeyToCoords, EMPTY_ID, World } from "@voxyl/core";
import { CITY_SEMANTICS, generateCity, mulberry32 } from "@voxyl/fixtures";
import { meshChunk, paddedVolume } from "@voxyl/mesher";
import { LightEngine, type LightMaterials, packEmission } from "../src/index.ts";

const args = process.argv.slice(2);
const bitsArg = args.find((a) => a.startsWith("--bits="));
const bitsList = bitsArg ? bitsArg.slice(7).split(",").map(Number) : [6];
const sizes = args.filter((a) => !a.startsWith("--")).map(Number);
const targets = sizes.length > 0 ? sizes : [5_000_000, 20_000_000];

const ms = (t: number) => `${t.toFixed(1)} ms`;
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

/** Glass lets light through, Glow emits cyan light, everything else blocks it. */
function cityMaterials(world: World): LightMaterials {
  const size = world.states.size + 1;
  const opaque = new Uint8Array(size);
  const emission = new Uint16Array(size);
  for (let id = 1; id < size; id++) {
    const semantic = world.states.get(id)?.semantic;
    opaque[id] = semantic === "Glass" ? 0 : 1;
    if (semantic === "Glow") emission[id] = packEmission("#22d3ee", 15);
  }
  return { opaque, emission };
}

for (const target of targets) {
  for (const bits of bitsList) {
    const world = new World({ chunkBits: bits });
    const stats = generateCity(world, { targetCells: target, seed: 1 });
    for (const s of CITY_SEMANTICS) world.states.intern({ semantic: s });
    const engine = new LightEngine(world, cityMaterials(world));

    let t = performance.now();
    engine.computeAll();
    const fullMs = performance.now() - t;
    const memoryMb = engine.memoryBytes / 2 ** 20;
    const lightChunks = engine.lightChunkCount;
    engine.takeDirtyChunks();

    // Mesh every chunk with and without light: lighting splits faces with gradients.
    const opaqueTable = cityMaterials(world).opaque;
    const cells = new Uint16Array(paddedVolume(bits));
    const lightCells = new Uint16Array(paddedVolume(bits));
    let unlitQuads = 0;
    let litQuads = 0;
    let litMeshMs = 0;
    for (const key of world.chunkKeys()) {
      const [kx, ky, kz] = chunkKeyToCoords(key);
      world.copyPadded(kx, ky, kz, cells);
      unlitQuads += meshChunk({ bits, cells, light: null, opaque: null }).quadCount;
      engine.copyPadded(kx, ky, kz, lightCells);
      const start = performance.now();
      litQuads += meshChunk({ bits, cells, light: lightCells, opaque: opaqueTable }).quadCount;
      litMeshMs += performance.now() - start;
    }

    world.recordChanges(true);
    const glow = world.states.intern({ semantic: "Glow" });
    const rand = mulberry32(7);
    const [x0, , z0] = stats.min;
    const [x1, y1, z1] = stats.max;

    // Single edits inside buildings and in the open: alternately place a Glow block (an
    // emitter) and remove a random existing cell.
    const single: number[] = [];
    const dirtyCounts: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(x0 + rand() * (x1 - x0));
      const z = Math.floor(z0 + rand() * (z1 - z0));
      const y = 1 + Math.floor(rand() * Math.min(60, y1));
      world.setId(x, y, z, i % 2 === 0 ? glow : EMPTY_ID);
      t = performance.now();
      engine.update(world.takeChanges());
      single.push(performance.now() - t);
      dirtyCounts.push(engine.takeDirtyChunks().length);
    }

    // A roof hole: clear a 5x5 patch of the tallest roof near the centre, so sky floods in.
    const cx = Math.round((x0 + x1) / 2);
    const cz = Math.round((z0 + z1) / 2);
    let roofY = -1;
    let roofX = cx;
    let roofZ = cz;
    for (let dz = -40; dz <= 40 && roofY < 0; dz += 4) {
      for (let dx = -40; dx <= 40 && roofY < 0; dx += 4) {
        for (let y = y1; y > 20; y--) {
          if (world.get(cx + dx, y, cz + dz)?.semantic === "Roof") {
            roofY = y;
            roofX = cx + dx;
            roofZ = cz + dz;
            break;
          }
        }
      }
    }
    const roof: string[] = [];
    if (roofY > 0) {
      for (const clear of [true, false]) {
        world.fillBox(
          roofX - 2,
          roofY,
          roofZ - 2,
          roofX + 2,
          roofY,
          roofZ + 2,
          clear ? EMPTY_ID : world.states.intern({ semantic: "Roof" }),
        );
        t = performance.now();
        engine.update(world.takeChanges());
        roof.push(
          `${clear ? "open" : "close"} ${ms(performance.now() - t)} (${engine.takeDirtyChunks().length} chunks)`,
        );
      }
    }

    // Bulk fills floating above the city, then cleared.
    const bulk: string[] = [];
    for (const [label, w, h, d] of [
      ["100k", 50, 40, 50],
      ["1M", 100, 100, 100],
    ] as const) {
      const bx = cx - Math.floor(w / 2);
      const bz = cz - Math.floor(d / 2);
      const by = y1 + 20;
      for (const clear of [false, true]) {
        world.fillBox(bx, by, bz, bx + w - 1, by + h - 1, bz + d - 1, clear ? EMPTY_ID : glow);
        t = performance.now();
        engine.update(world.takeChanges());
        bulk.push(
          `${label} ${clear ? "clear" : "fill"} ${ms(performance.now() - t)} (${engine.takeDirtyChunks().length} chunks)`,
        );
      }
    }

    console.log(
      [
        `${(world.cellCount / 1e6).toFixed(2)}M cells, ${1 << bits}^3 chunks:`,
        `light all ${ms(fullMs)} (scan ${ms(engine.lastTimings.scanMs)}, sky ${ms(engine.lastTimings.skyMs)}, block ${ms(engine.lastTimings.blockMs)})`,
        `memory ${memoryMb.toFixed(0)} MB (${lightChunks} of ${world.chunkCount} chunks hold light arrays)`,
        `quads ${(unlitQuads / 1e6).toFixed(2)}M unlit, ${(litQuads / 1e6).toFixed(2)}M lit (lit meshing ${ms(litMeshMs / world.chunkCount)} per chunk)`,
        `single edit p50 ${ms(pct(single, 0.5))} p95 ${ms(pct(single, 0.95))} max ${ms(Math.max(...single))}, remesh p50 ${pct(dirtyCounts, 0.5)} chunks`,
        `roof hole: ${roof.join(", ") || "no roof found"}`,
        `bulk: ${bulk.join(", ")}`,
      ].join("\n  "),
    );
  }
}
