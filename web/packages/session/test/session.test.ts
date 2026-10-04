import { type CellStateTable, chunkKeyToCoords, World } from "@voxyl/core";
import { LightEngine, type LightMaterials, packEmission } from "@voxyl/light";
import { type ChunkMesh, meshChunk, paddedVolume } from "@voxyl/mesher";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type LightingMode, type MaterialsFor, WorldSession } from "../src/index.ts";

const SEMANTICS = ["Stone", "Glass", "Lamp", "Crystal"] as const;

/** Stone blocks light; Glass doesn't; Lamp is an opaque red emitter; Crystal a clear cyan one. */
function materialsWith(lampLevel: number): MaterialsFor {
  return (states: CellStateTable): LightMaterials => {
    const opaque = new Uint8Array(states.size + 1);
    const emission = new Uint16Array(states.size + 1);
    for (let id = 1; id <= states.size; id++) {
      const semantic = states.get(id)?.semantic;
      opaque[id] = semantic === "Glass" || semantic === "Crystal" ? 0 : 1;
      if (semantic === "Lamp") emission[id] = packEmission("#ff4000", lampLevel);
      if (semantic === "Crystal") emission[id] = packEmission("#00ffff", 9);
    }
    return { opaque, emission };
  };
}

/** What the renderer would hold: the latest mesh and light per chunk, as handed out. */
interface View {
  meshes: Map<number, ChunkMesh>;
  lights: Map<number, Uint16Array>;
}

/** Runs the session's work to completion, meshing on this thread, as a worker would. */
function settle(session: WorldSession, view: View): void {
  // The renderer keeps a light volume only with volume lighting.
  if (session.lighting !== "volume") view.lights.clear();
  for (let round = 0; round < 1000; round++) {
    session.sync();
    for (let job = session.takeJob(); job; job = session.takeJob()) {
      const mesh = meshChunk(job);
      if (mesh.quadCount > 0) view.meshes.set(job.key, mesh);
      else {
        view.meshes.delete(job.key);
        view.lights.delete(job.key);
      }
      session.finishJob(job.key, job.jobId, mesh.quadCount);
    }
    for (const key of session.takeRemoved()) {
      view.meshes.delete(key);
      view.lights.delete(key);
    }
    for (let slot = session.takeLight(); slot; slot = session.takeLight()) {
      view.lights.set(slot.key, slot.light);
    }
    if (session.idle) return;
  }
  throw new Error("the session never settled");
}

/** Meshes and light built from scratch for the world as it is now. */
function expectFresh(world: World, view: View, mode: LightingMode, materials: MaterialsFor) {
  const bits = world.layout.bits;
  const engine = mode === "off" ? null : new LightEngine(world, materials(world.states));
  engine?.computeAll();
  const meshes = new Map<number, ChunkMesh>();
  for (const key of world.chunkKeys()) {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    const cells = world.copyPadded(cx, cy, cz, new Uint16Array(paddedVolume(bits)));
    const baked = mode === "vertex" ? engine : null;
    const mesh = meshChunk({
      bits,
      cells,
      light: baked ? baked.copyPadded(cx, cy, cz, new Uint16Array(paddedVolume(bits))) : null,
      opaque: baked ? materials(world.states).opaque : null,
    });
    if (mesh.quadCount > 0) meshes.set(key, mesh);
  }
  expect([...view.meshes.keys()].sort()).toEqual([...meshes.keys()].sort());
  for (const [key, mesh] of meshes) {
    expect(view.meshes.get(key)?.quads, `mesh of chunk ${key}`).toEqual(mesh.quads);
  }
  const lightKeys = mode === "volume" ? [...meshes.keys()].sort() : [];
  expect([...view.lights.keys()].sort()).toEqual(lightKeys);
  // Light is only defined from the row below the lowest cell up: an engine that has seen
  // lower cells keeps lighting rows a fresh one leaves dark. No face reads below that row.
  let minY = Number.POSITIVE_INFINITY;
  world.forEachCell((_x, y) => {
    minY = Math.min(minY, y);
  });
  const S = world.layout.size;
  const P = S + 2;
  const belowFloor = (key: number, light: Uint16Array) => {
    const out = light.slice();
    const oy = chunkKeyToCoords(key)[1] * S - 1;
    for (let py = 0; py < P && oy + py < minY - 1; py++) out.fill(0, py * P * P, (py + 1) * P * P);
    return out;
  };
  for (const key of lightKeys) {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    const fresh = engine?.copyPadded(cx, cy, cz, new Uint16Array(paddedVolume(bits)), true);
    const sent = view.lights.get(key);
    expect(sent && belowFloor(key, sent), `light of chunk ${key}`).toEqual(
      fresh && belowFloor(key, fresh),
    );
  }
}

const coord = fc.integer({ min: -10, max: 10 });
const boxArb = fc.record({
  at: fc.tuple(coord, fc.integer({ min: 0, max: 10 }), coord),
  size: fc.tuple(fc.nat(5), fc.nat(5), fc.nat(5)),
  semantic: fc.constantFrom(...SEMANTICS, null),
});
type Box = typeof boxArb extends fc.Arbitrary<infer T> ? T : never;

function apply(world: World, box: Box): void {
  const id = box.semantic ? world.states.intern({ semantic: box.semantic }) : 0;
  const [x, y, z] = box.at;
  const [w, h, d] = box.size;
  world.fillBox(x, y, z, x + w, y + h, z + d, id);
}

describe("WorldSession", () => {
  it.each(["off", "vertex", "volume"] as const)(
    "hands out exactly the meshes and light of a fresh build after edits (%s lighting)",
    (mode) => {
      const materials = materialsWith(14);
      fc.assert(
        fc.property(
          fc.array(boxArb, { minLength: 1, maxLength: 6 }),
          fc.array(fc.array(boxArb, { minLength: 1, maxLength: 3 }), { maxLength: 4 }),
          (initial, batches) => {
            const world = new World({ chunkBits: 3 });
            for (const box of initial) apply(world, box);
            const session = new WorldSession(world);
            session.setLighting(mode, materials);
            const view: View = { meshes: new Map(), lights: new Map() };
            settle(session, view);
            expectFresh(world, view, mode, materials);
            for (const batch of batches) {
              for (const box of batch) apply(world, box);
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
        fc.array(fc.constantFrom("off", "vertex", "volume", "palette"), { maxLength: 6 }),
        (initial, steps) => {
          const world = new World({ chunkBits: 3 });
          for (const box of initial) apply(world, box);
          const session = new WorldSession(world);
          const view: View = { meshes: new Map(), lights: new Map() };
          let lampLevel = 14;
          let materials = materialsWith(lampLevel);
          settle(session, view);
          for (const step of steps) {
            if (step === "palette") {
              lampLevel = lampLevel === 14 ? 7 : 14;
              materials = materialsWith(lampLevel);
              session.setMaterials(materials);
            } else {
              session.setLighting(step, materials);
            }
            settle(session, view);
            expectFresh(world, view, session.lighting, materials);
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);

  it("meshes the chunks nearest the camera first", () => {
    const world = new World({ chunkBits: 3 });
    const stone = world.states.intern({ semantic: "Stone" });
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
