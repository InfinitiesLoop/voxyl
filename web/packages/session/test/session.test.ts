import { type CellStateTable, chunkKeyToCoords, World } from "@voxyl/core";
import { GPU_BRICK_BITS, LightEngine, type LightMaterials, packEmission } from "@voxyl/light";
import { type ChunkMesh, meshChunk, paddedVolume, ShapeTable } from "@voxyl/mesher";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type LightingMode,
  type LightLayoutUpdate,
  type MaterialsFor,
  WorldSession,
} from "../src/index.ts";

// Semantic ids (names live in a project's registry; cells hold ids).
const STONE = 1;
const GLASS = 2;
const LAMP = 3;
const CRYSTAL = 4;

const SEMANTICS = [STONE, GLASS, LAMP, CRYSTAL] as const;

/** Stone blocks light; Glass doesn't; Lamp is an opaque red emitter; Crystal a clear cyan one. */
function materialsWith(lampLevel: number): MaterialsFor {
  return (states: CellStateTable): LightMaterials => {
    const opaque = new Uint8Array(states.size + 1);
    const emission = new Uint16Array(states.size + 1);
    for (let id = 1; id <= states.size; id++) {
      const semantic = states.get(id)?.semantic;
      opaque[id] = semantic === GLASS || semantic === CRYSTAL ? 0 : 1;
      if (semantic === LAMP) emission[id] = packEmission("#ff4000", lampLevel);
      if (semantic === CRYSTAL) emission[id] = packEmission("#00ffff", 9);
    }
    return { opaque, emission };
  };
}

/** What the renderer would hold: meshes, and the light volume's textures as maps. */
interface View {
  meshes: Map<number, ChunkMesh>;
  pool: Map<number, Uint16Array>;
  tables: Map<number, Uint32Array>;
  grid: LightLayoutUpdate["grid"];
}

const newView = (): View => ({ meshes: new Map(), pool: new Map(), tables: new Map(), grid: null });

function apply(view: View, update: LightLayoutUpdate, brickVolume: number, tableLength: number) {
  update.slots.forEach((slot, i) => {
    view.pool.set(slot, update.bricks.slice(i * brickVolume, (i + 1) * brickVolume));
  });
  update.tables.forEach((table, i) => {
    view.tables.set(table, update.tableData.slice(i * tableLength, (i + 1) * tableLength));
  });
  if (update.grid) view.grid = update.grid;
}

const tables = new WeakMap<WorldSession, ShapeTable>();

/** Runs the session's work to completion, meshing on this thread, as the workers would. */
function settle(session: WorldSession, view: View): void {
  let table = tables.get(session);
  if (!table) {
    table = new ShapeTable();
    tables.set(session, table);
  }
  // The renderer keeps a light volume only with lighting on.
  if (session.lighting === "off") {
    view.pool.clear();
    view.tables.clear();
    view.grid = null;
  }
  for (let round = 0; round < 1000; round++) {
    session.sync();
    const added = session.takeShapes();
    if (added) table.update(added.from, added.shapes);
    for (let job = session.takeJob(); job; job = session.takeJob()) {
      const mesh = meshChunk(job, table);
      if (mesh.quadCount > 0) view.meshes.set(job.key, mesh);
      else view.meshes.delete(job.key);
      session.finishJob(job.key, job.jobId, mesh.lightBricks);
    }
    for (const key of session.takeRemoved()) view.meshes.delete(key);
    const layout = session.layout;
    for (let u = session.takeLightUpdate(7); u && layout; u = session.takeLightUpdate(7)) {
      apply(view, u, layout.brickVolume, layout.tableLength);
    }
    if (session.idle) return;
  }
  throw new Error("the session never settled");
}

/** A cell's light as the shader finds it: grid, then table, then pool; null if missing. */
function lookup(view: View, world: World, x: number, y: number, z: number): number | null {
  const grid = view.grid;
  if (!grid) return null;
  const S = world.layout.size;
  const G = 1 << GPU_BRICK_BITS;
  const n = S / G;
  const c = [Math.floor(x / S), Math.floor(y / S), Math.floor(z / S)];
  const g = c.map((v, i) => v - (grid.origin[i] ?? 0));
  if (g.some((v, i) => v < 0 || v >= (grid.size[i] ?? 0))) return null;
  const [sx, , sz] = grid.size;
  const table = grid.data[(g[0] ?? 0) + (g[2] ?? 0) * sx + (g[1] ?? 0) * sx * sz] ?? 0;
  if (table === 0) return null;
  const lx = x - (c[0] ?? 0) * S;
  const ly = y - (c[1] ?? 0) * S;
  const lz = z - (c[2] ?? 0) * S;
  const local = Math.floor(lx / G) + Math.floor(lz / G) * n + Math.floor(ly / G) * n * n;
  const slot = view.tables.get(table - 1)?.[local] ?? 0;
  if (slot === 0) return null;
  return view.pool.get(slot - 1)?.[(lx % G) + (lz % G) * G + (ly % G) * G * G] ?? null;
}

/** The view must hold exactly what a fresh build of the world would. */
function expectFresh(world: World, view: View, mode: LightingMode, materials: MaterialsFor) {
  const bits = world.layout.bits;
  const S = world.layout.size;
  const G = 1 << GPU_BRICK_BITS;
  const n = S / G;
  const NB = n + 2;
  const meshes = new Map<number, ChunkMesh>();
  const needed = new Set<string>(); // world brick coordinates faces read
  for (const key of world.chunkKeys()) {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    const cells = world.copyPadded(cx, cy, cz, new Uint16Array(paddedVolume(bits)));
    const mesh = meshChunk(
      { bits, cells, lightBrickBits: GPU_BRICK_BITS },
      ShapeTable.of(world.states),
    );
    if (mesh.quadCount > 0) meshes.set(key, mesh);
    for (const b of mesh.lightBricks) {
      needed.add(
        `${cx * n + (b % NB) - 1},${cy * n + Math.floor(b / (NB * NB)) - 1},${cz * n + (Math.floor(b / NB) % NB) - 1}`,
      );
    }
  }
  expect([...view.meshes.keys()].sort()).toEqual([...meshes.keys()].sort());
  for (const [key, mesh] of meshes) {
    expect(view.meshes.get(key)?.quads, `mesh of chunk ${key}`).toEqual(mesh.quads);
  }
  if (mode === "off") {
    expect(view.pool.size).toBe(0);
    return;
  }
  const engine = new LightEngine(world, materials(world.states));
  engine.computeAll();
  // Light is only defined from the row below the lowest cell up: an engine that has seen
  // lower cells keeps lighting rows a fresh one leaves dark. No face reads below that row.
  let minY = Number.POSITIVE_INFINITY;
  world.forEachCell((_x, y) => {
    minY = Math.min(minY, y);
  });
  const one = new Uint16Array(1);
  for (const at of needed) {
    const [bx, by, bz] = at.split(",").map(Number) as [number, number, number];
    for (let y = by * G; y < by * G + G; y++) {
      if (y < minY - 1) continue;
      for (let z = bz * G; z < bz * G + G; z++) {
        for (let x = bx * G; x < bx * G + G; x++) {
          const want = engine.copyBox([x, y, z], [1, 1, 1], one, true)[0];
          expect(lookup(view, world, x, y, z), `light at ${x},${y},${z}`).toBe(want);
        }
      }
    }
  }
  // Nothing else: every table entry points at a brick some face reads.
  const grid = view.grid;
  if (!grid) return;
  for (let gy = 0; gy < grid.size[1]; gy++) {
    for (let gz = 0; gz < grid.size[2]; gz++) {
      for (let gx = 0; gx < grid.size[0]; gx++) {
        const table = grid.data[gx + gz * grid.size[0] + gy * grid.size[0] * grid.size[2]] ?? 0;
        if (table === 0) continue;
        const entries = view.tables.get(table - 1);
        entries?.forEach((slot, local) => {
          if (slot === 0) return;
          const bx = (gx + grid.origin[0]) * n + (local % n);
          const bz = (gz + grid.origin[2]) * n + (Math.floor(local / n) % n);
          const by = (gy + grid.origin[1]) * n + Math.floor(local / (n * n));
          expect(needed.has(`${bx},${by},${bz}`), `brick ${bx},${by},${bz} kept but unread`).toBe(
            true,
          );
        });
      }
    }
  }
}

const coord = fc.integer({ min: -10, max: 10 });
const boxArb = fc.record({
  at: fc.tuple(coord, fc.integer({ min: 0, max: 10 }), coord),
  size: fc.tuple(fc.nat(5), fc.nat(5), fc.nat(5)),
  semantic: fc.constantFrom(...SEMANTICS, null),
});
type Box = typeof boxArb extends fc.Arbitrary<infer T> ? T : never;

function edit(world: World, box: Box): void {
  const id = box.semantic ? world.states.intern({ semantic: box.semantic }) : 0;
  const [x, y, z] = box.at;
  const [w, h, d] = box.size;
  world.fillBox(x, y, z, x + w, y + h, z + d, id);
}

describe("WorldSession", () => {
  it.each(["off", "volume"] as const)(
    "hands out exactly the meshes and light of a fresh build after edits (%s lighting)",
    (mode) => {
      const materials = materialsWith(14);
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 4 }),
          fc.array(boxArb, { minLength: 1, maxLength: 6 }),
          fc.array(fc.array(boxArb, { minLength: 1, maxLength: 3 }), { maxLength: 4 }),
          (chunkBits, initial, batches) => {
            const world = new World({ chunkBits });
            for (const box of initial) edit(world, box);
            const session = new WorldSession(world);
            session.setLighting(mode, materials);
            const view = newView();
            settle(session, view);
            expectFresh(world, view, mode, materials);
            for (const batch of batches) {
              for (const box of batch) edit(world, box);
              settle(session, view);
              expectFresh(world, view, mode, materials);
            }
          },
        ),
        { numRuns: 25 },
      );
    },
    120_000,
  );

  it("stays exact across lighting switches and palette changes", () => {
    fc.assert(
      fc.property(
        fc.array(boxArb, { minLength: 1, maxLength: 6 }),
        fc.array(fc.oneof(fc.constantFrom("off", "volume", "palette"), boxArb), { maxLength: 8 }),
        (initial, steps) => {
          const world = new World({ chunkBits: 4 });
          for (const box of initial) edit(world, box);
          const session = new WorldSession(world);
          const view = newView();
          let lampLevel = 14;
          let materials = materialsWith(lampLevel);
          settle(session, view);
          for (const step of steps) {
            if (step === "palette") {
              lampLevel = lampLevel === 14 ? 7 : 14;
              materials = materialsWith(lampLevel);
              session.setMaterials(materials);
            } else if (step === "off" || step === "volume") {
              session.setLighting(step, materials);
            } else {
              edit(world, step);
            }
            settle(session, view);
            expectFresh(world, view, session.lighting, materials);
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);

  it("starts a new mesh at once when a chunk changes while one is in flight", () => {
    const world = new World({ chunkBits: 3 });
    const stone = world.states.intern({ semantic: STONE });
    world.setId(1, 1, 1, stone);
    const session = new WorldSession(world);
    session.sync();
    const first = session.takeJob();
    expect(first).not.toBeNull();
    world.setId(2, 1, 1, stone);
    session.sync();
    const second = session.takeJob();
    expect(second?.key).toBe(first?.key);
    expect(second?.jobId).not.toBe(first?.jobId);
    const none = new Uint16Array(0);
    expect(session.finishJob(first?.key ?? 0, first?.jobId ?? 0, none)).toBe(false);
    expect(session.finishJob(second?.key ?? 0, second?.jobId ?? 0, none)).toBe(true);
    expect(session.idle).toBe(true);
  });

  it("meshes the chunks nearest the camera first", () => {
    const world = new World({ chunkBits: 3 });
    const stone = world.states.intern({ semantic: STONE });
    for (let i = 0; i < 6; i++) world.setId(i * 8, 0, 0, stone);
    const session = new WorldSession(world);
    session.setCamera(44, 0, 0);
    const order: number[] = [];
    for (let job = session.takeJob(); job; job = session.takeJob()) {
      order.push(chunkKeyToCoords(job.key)[0]);
    }
    expect(order).toEqual([5, 4, 3, 2, 1, 0]);
  });
});
