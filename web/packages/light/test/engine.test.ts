import { World } from "@voxyl/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FULL_SKY,
  LightEngine,
  type LightMaterials,
  OPAQUE_LIGHT,
  packEmission,
} from "../src/index.ts";

const SEMANTICS = ["Stone", "Glass", "Lamp", "Crystal"] as const;

/** Stone blocks light; Glass doesn't; Lamp is an opaque red emitter; Crystal a clear cyan one. */
function setup(chunkBits = 3) {
  const world = new World({ chunkBits });
  const ids = SEMANTICS.map((semantic) => world.states.intern({ semantic }));
  const opaque = new Uint8Array(ids.length + 1);
  const emission = new Uint16Array(ids.length + 1);
  const [stone, , lamp, crystal] = ids as [number, number, number, number];
  opaque[stone] = 1;
  opaque[lamp] = 1;
  emission[lamp] = packEmission("#ff4000", 14);
  emission[crystal] = packEmission("#00ffff", 9);
  return { world, ids, materials: { opaque, emission } as LightMaterials };
}

interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

function contentBounds(world: World): Box | null {
  let b: Box | null = null;
  world.forEachCell((x, y, z) => {
    if (!b) b = { x0: x, y0: y, z0: z, x1: x, y1: y, z1: z };
    else {
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.z0 = Math.min(b.z0, z);
      b.x1 = Math.max(b.x1, x);
      b.y1 = Math.max(b.y1, y);
      b.z1 = Math.max(b.z1, z);
    }
  });
  return b;
}

/**
 * The obvious, slow definition of the light: start sources (open sky above each column's
 * highest blocker, emitters), then relax every cell until nothing changes. Cells outside the
 * region count as open sky if exposed and dark otherwise; the region is wide enough that
 * light can't reach in from beyond it.
 */
function oracle(world: World, materials: LightMaterials, bounds: Box) {
  const pad = 16;
  const r = {
    x0: bounds.x0 - pad,
    x1: bounds.x1 + pad,
    y0: bounds.y0 - 1,
    y1: bounds.y1 + pad,
    z0: bounds.z0 - pad,
    z1: bounds.z1 + pad,
  };
  const W = r.x1 - r.x0 + 1;
  const H = r.y1 - r.y0 + 1;
  const D = r.z1 - r.z0 + 1;
  const tops = new Map<string, number>();
  world.forEachCell((x, y, z, id) => {
    if (materials.opaque[id])
      tops.set(`${x},${z}`, Math.max(tops.get(`${x},${z}`) ?? -Infinity, y));
  });
  const exposed = (x: number, y: number, z: number) => y > (tops.get(`${x},${z}`) ?? -Infinity);
  const index = (x: number, y: number, z: number) => x - r.x0 + (z - r.z0) * W + (y - r.y0) * W * D;
  const inside = (x: number, y: number, z: number) =>
    x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && z >= r.z0 && z <= r.z1;
  const light = new Uint16Array(W * H * D);
  const ids = new Uint16Array(W * H * D);
  for (let y = r.y0; y <= r.y1; y++)
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const id = world.getId(x, y, z);
        ids[index(x, y, z)] = id;
        let v = materials.emission[id] ?? 0;
        if (!materials.opaque[id] && exposed(x, y, z)) v |= FULL_SKY;
        light[index(x, y, z)] = v;
      }
  const at = (x: number, y: number, z: number) =>
    inside(x, y, z) ? (light[index(x, y, z)] ?? 0) : exposed(x, y, z) ? FULL_SKY : 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let y = r.y0; y <= r.y1; y++)
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) {
          const i = index(x, y, z);
          if (materials.opaque[ids[i] ?? 0]) continue;
          const own = light[i] ?? 0;
          let next = own;
          for (const [dx, dy, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ] as const) {
            const n = at(x + dx, y + dy, z + dz);
            for (const shift of [12, 8, 4, 0]) {
              const want = ((n >> shift) & 15) - 1;
              if (want > ((next >> shift) & 15)) next = (next & ~(15 << shift)) | (want << shift);
            }
          }
          if (next !== own) {
            light[i] = next;
            changed = true;
          }
        }
  }
  return at;
}

/** Compares the engine with `expected` over the content plus one cell all round. */
function expectLight(
  engine: LightEngine,
  expected: (x: number, y: number, z: number) => number,
  b: Box,
) {
  for (let y = b.y0 - 1; y <= b.y1 + 1; y++)
    for (let z = b.z0 - 1; z <= b.z1 + 1; z++)
      for (let x = b.x0 - 1; x <= b.x1 + 1; x++) {
        const got = engine.get(x, y, z);
        const want = expected(x, y, z);
        if (got !== want) {
          expect(`[${x},${y},${z}] ${got.toString(16)}`).toBe(
            `[${x},${y},${z}] ${want.toString(16)}`,
          );
        }
      }
}

const coord = fc.integer({ min: -9, max: 9 });
const boxArb = fc.record({
  a: fc.tuple(coord, fc.integer({ min: 0, max: 9 }), coord),
  size: fc.tuple(fc.nat(5), fc.nat(5), fc.nat(5)),
  kind: fc.integer({ min: 0, max: 5 }), // 0..3 = a semantic, 4..5 = clear
});

function applyBox(
  world: World,
  ids: number[],
  box: {
    a: readonly [number, number, number];
    size: readonly [number, number, number];
    kind: number;
  },
) {
  const [x, y, z] = box.a;
  const [w, h, d] = box.size;
  const id = box.kind < ids.length ? (ids[box.kind] ?? 0) : 0;
  world.fillBox(x, y, z, x + w, y + h, z + d, id);
}

describe("LightEngine", () => {
  it("lights a sealed room only from its lamp, and the open air with sky", () => {
    const { world, ids, materials } = setup();
    const [stone, , lamp] = ids as [number, number, number];
    world.fillBox(0, 0, 0, 6, 6, 6, stone);
    world.fillBox(1, 1, 1, 5, 5, 5, 0); // hollow it out
    world.setId(1, 1, 1, lamp);
    const engine = new LightEngine(world, materials);
    engine.computeAll();
    expect(engine.get(3, 10, 3) >> 12).toBe(15); // open sky above
    expect(engine.get(3, 3, 3) >> 12).toBe(0); // no sky inside
    expect((engine.get(2, 1, 1) >> 8) & 15).toBe(13); // red 14 at the lamp, 13 beside it
    expect((engine.get(5, 5, 5) >> 8) & 15).toBe(14 - 12); // 12 steps away
  });

  it("lets sky light in through glass and around overhangs", () => {
    const { world, ids, materials } = setup();
    const [stone, glass] = ids as [number, number];
    world.fillBox(0, 4, 0, 4, 4, 4, stone); // a roof on nothing
    world.setId(2, 4, 2, glass); // with a glass skylight
    const engine = new LightEngine(world, materials);
    engine.computeAll();
    expect(engine.get(2, 3, 2) >> 12).toBe(15); // straight under the skylight: still open sky
    expect(engine.get(1, 3, 2) >> 12).toBe(14); // beside it, one step in
    expect(engine.get(1, 3, 1) >> 12).toBe(13); // diagonal: two steps
    expect(engine.get(-1, 3, 2) >> 12).toBe(15); // outside the roof
  });

  it.each([3, 4])(
    "matches the slow definition on random worlds (%i-bit chunks)",
    (chunkBits) => {
      fc.assert(
        fc.property(fc.array(boxArb, { minLength: 1, maxLength: 10 }), (boxes) => {
          const { world, ids, materials } = setup(chunkBits);
          for (const box of boxes) applyBox(world, ids, box);
          const bounds = contentBounds(world);
          if (!bounds) return;
          const engine = new LightEngine(world, materials);
          engine.computeAll();
          expectLight(engine, oracle(world, materials, bounds), bounds);
        }),
        { numRuns: 40 },
      );
    },
    60_000,
  );

  it.each([3, 4])(
    "copies a chunk's padded light, optionally marking light-blocking cells (%i-bit chunks)",
    (chunkBits) => {
      fc.assert(
        fc.property(fc.array(boxArb, { minLength: 1, maxLength: 10 }), (boxes) => {
          const { world, ids, materials } = setup(chunkBits);
          for (const box of boxes) applyBox(world, ids, box);
          const engine = new LightEngine(world, materials);
          engine.computeAll();
          const S = world.layout.size;
          const P = S + 2;
          const plain = new Uint16Array(P ** 3);
          const marked = new Uint16Array(P ** 3);
          for (const [cx, cy, cz] of [
            [0, 0, 0],
            [-1, 0, 0],
            [0, -1, 1],
          ] as const) {
            engine.copyPadded(cx, cy, cz, plain);
            engine.copyPadded(cx, cy, cz, marked, true);
            for (let py = 0; py < P; py++) {
              for (let pz = 0; pz < P; pz++) {
                for (let px = 0; px < P; px++) {
                  const x = cx * S + px - 1;
                  const y = cy * S + py - 1;
                  const z = cz * S + pz - 1;
                  const i = px + pz * P + py * P * P;
                  const light = engine.get(x, y, z);
                  const want = (materials.opaque[world.getId(x, y, z)] ?? 0) ? OPAQUE_LIGHT : light;
                  if (plain[i] !== light || marked[i] !== want) {
                    expect({ x, y, z, plain: plain[i], marked: marked[i] }).toEqual({
                      x,
                      y,
                      z,
                      plain: light,
                      marked: want,
                    });
                  }
                }
              }
            }
          }
        }),
        { numRuns: 30 },
      );
    },
    60_000,
  );

  it("relights edits incrementally to exactly what a full recompute gives", () => {
    fc.assert(
      fc.property(
        fc.array(boxArb, { minLength: 1, maxLength: 8 }),
        fc.array(fc.array(boxArb, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 5 }),
        (initial, batches) => {
          const { world, ids, materials } = setup();
          for (const box of initial) applyBox(world, ids, box);
          const engine = new LightEngine(world, materials);
          engine.computeAll();
          world.recordChanges(true);
          for (const batch of batches) {
            for (const box of batch) applyBox(world, ids, box);
            engine.update(world.takeChanges());
            const fresh = new LightEngine(world, materials);
            fresh.computeAll();
            const bounds = contentBounds(world) ?? { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 };
            // Wider than the content: removed blocks leave light to clean up around them.
            const wide = { x0: -16, y0: bounds.y0, z0: -16, x1: 16, y1: 16, z1: 16 };
            expectLight(engine, (x, y, z) => fresh.get(x, y, z), wide);
          }
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);
});
