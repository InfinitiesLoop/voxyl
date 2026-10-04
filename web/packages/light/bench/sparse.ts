// How sparse can GPU light be? Faces read light only from the empty cell in front of them
// and its in-plane neighbours, so a brick of light is needed only if it holds such a cell.
// Counts those bricks on the city and estimates the memory of a brick pool with a one-cell
// apron, against dense padded chunk slots.
// Run from web/: node packages/light/bench/sparse.ts [cells]

import { chunkKey, chunkKeyToCoords, World } from "@voxyl/core";
import { generateCity } from "@voxyl/fixtures";
import { meshChunk, paddedVolume } from "@voxyl/mesher";
import { LightEngine, packEmission } from "../src/index.ts";

const target = Number(process.argv[2] ?? 5_000_000);
const world = new World({ chunkBits: 6 });
generateCity(world, { targetCells: target, seed: 1 });

const D = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

const start = performance.now();
const bricks = new Map<number, Set<number>>([
  [2, new Set()],
  [3, new Set()],
  [4, new Set()],
]);
let faces = 0;
world.forEachCell((x, y, z) => {
  for (const [dx, dy, dz] of D) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (world.getId(nx, ny, nz) !== 0) continue;
    faces++;
    for (const [bits, set] of bricks) set.add(chunkKey(nx >> bits, ny >> bits, nz >> bits));
  }
});
const ms = performance.now() - start;

const chunks = world.chunkCount;
const dense = chunks * 66 ** 3 * 2;
console.log(
  `${(world.cellCount / 1e6).toFixed(2)}M cells, ${chunks} chunks, ${faces} visible faces`,
);
console.log(`dense padded slots: ${(dense / 2 ** 20).toFixed(0)} MB`);
for (const [bits, set] of bricks) {
  const B = 1 << bits;
  const perChunk = (64 / B) ** 3;
  const bytes = set.size * (B + 2) ** 3 * 2;
  console.log(
    `${B}³ bricks: ${set.size} needed of ${chunks * perChunk} (${((100 * set.size) / (chunks * perChunk)).toFixed(0)}%), ` +
      `pool ${(bytes / 2 ** 20).toFixed(0)} MB with apron`,
  );
}
console.log(`(scan ${ms.toFixed(0)} ms)`);

// CPU side: light bricks that differ from the default (open sky above each column's highest
// light-blocking cell, dark below). Only those need storing; uniform ones need one value.
const size = world.states.size + 1;
const opaque = new Uint8Array(size);
const emission = new Uint16Array(size);
for (let id = 1; id < size; id++) {
  const semantic = world.states.get(id)?.semantic;
  opaque[id] = semantic === "Glass" ? 0 : 1;
  if (semantic === "Glow") emission[id] = packEmission("#22d3ee", 15);
}
const engine = new LightEngine(world, { opaque, emission });
engine.computeAll();
const tops = new Map<number, number>();
world.forEachCell((x, y, z, id) => {
  if (!opaque[id]) return;
  const column = chunkKey(x, 0, z);
  if (y > (tops.get(column) ?? Number.NEGATIVE_INFINITY)) tops.set(column, y);
});
let minY = Number.POSITIVE_INFINITY;
world.forEachCell((_x, y) => {
  minY = Math.min(minY, y);
});
const keys = new Set<number>();
for (const key of world.chunkKeys()) {
  const [cx, cy, cz] = chunkKeyToCoords(key);
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) keys.add(chunkKey(cx + dx, cy + dy, cz + dz));
}
for (const B of [8, 16]) {
  let varied = 0;
  let uniform = 0;
  let total = 0;
  for (const key of keys) {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    for (let by = 0; by < 64; by += B)
      for (let bz = 0; bz < 64; bz += B)
        for (let bx = 0; bx < 64; bx += B) {
          total++;
          let differs = false;
          let first = -1;
          let same = true;
          for (let y = 0; y < B; y++)
            for (let z = 0; z < B; z++)
              for (let x = 0; x < B; x++) {
                const wx = cx * 64 + bx + x;
                const wy = cy * 64 + by + y;
                const wz = cz * 64 + bz + z;
                const value = wy < minY - 1 ? 0 : engine.get(wx, wy, wz);
                const top = tops.get(chunkKey(wx, 0, wz)) ?? Number.NEGATIVE_INFINITY;
                const fallback = wy > top && wy >= minY - 1 ? 0xf000 : 0;
                if (value !== fallback) differs = true;
                if (first < 0) first = value;
                else if (value !== first) same = false;
              }
          if (differs) {
            if (same) uniform++;
            else varied++;
          }
        }
  }
  console.log(
    `CPU ${B}³ bricks: ${varied} vary, ${uniform} uniform but not default, of ${total} ` +
      `(${((varied * B ** 3 * 2) / 2 ** 20).toFixed(0)} MB stored vs ${(engine.memoryBytes / 2 ** 20).toFixed(0)} MB now)`,
  );
}

// GPU option: bricks next to faces whose light (apron included) differs from the default the
// shader could compute from a heightmap texture.
const differsFromDefault = (wx: number, wy: number, wz: number) => {
  const value = wy < minY - 1 ? 0 : engine.get(wx, wy, wz);
  const top = tops.get(chunkKey(wx, 0, wz)) ?? Number.NEGATIVE_INFINITY;
  return value !== (wy > top && wy >= minY - 1 ? 0xf000 : 0);
};
for (const [bits, set] of bricks) {
  if (bits === 2) continue;
  const B = 1 << bits;
  let kept = 0;
  for (const key of set) {
    const [bx, by, bz] = chunkKeyToCoords(key);
    let differs = false;
    for (let y = -1; y <= B && !differs; y++)
      for (let z = -1; z <= B && !differs; z++)
        for (let x = -1; x <= B && !differs; x++)
          differs = differsFromDefault(bx * B + x, by * B + y, bz * B + z);
    if (differs) kept++;
  }
  console.log(
    `GPU ${B}³ bricks next to faces and not default: ${kept} (${((kept * (B + 2) ** 3 * 2) / 2 ** 20).toFixed(0)} MB with apron)`,
  );
}

// GPU option: per-face light, each greedy quad carrying a (w + 2) x (h + 2) grid of light
// around it (the ring is for smoothing and occlusion), so memory follows surface area.
let grid = 0;
let quads = 0;
const cells = new Uint16Array(paddedVolume(6));
for (const key of world.chunkKeys()) {
  const [cx, cy, cz] = chunkKeyToCoords(key);
  const mesh = meshChunk({
    bits: 6,
    cells: world.copyPadded(cx, cy, cz, cells),
    light: null,
    opaque: null,
  });
  for (let q = 0; q < mesh.quadCount; q++) {
    const w = mesh.quads[q * mesh.quadBytes + 4] ?? 0;
    const h = mesh.quads[q * mesh.quadBytes + 5] ?? 0;
    grid += (w + 2) * (h + 2);
  }
  quads += mesh.quadCount;
}
console.log(
  `GPU per-face light: ${(grid / 1e6).toFixed(1)}M cells for ${(quads / 1e6).toFixed(2)}M quads, ` +
    `${((grid * 2) / 2 ** 20).toFixed(0)} MB (+${((quads * 4) / 2 ** 20).toFixed(0)} MB of offsets)`,
);
