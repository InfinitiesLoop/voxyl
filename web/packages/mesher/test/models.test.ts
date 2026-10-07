import { World } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  type ModelFaces,
  type ModelShape,
  meshChunk,
  paddedVolume,
  QUAD_WORDS,
  ShapeTable,
} from "../src/index.ts";

const MASS = 1;
const SLAB = 2;
const FENCE = 3;

/** A bottom slab: faces as [face, plane, u0, v0, u1, v1] in sixteenths (see FACES). */
const SLAB_FACES: ModelFaces = {
  rects: [
    [0, 16, 0, 0, 8, 16], // +X: u = y, v = z
    [1, 0, 0, 0, 16, 8], // -X: u = z, v = y
    [2, 8, 0, 0, 16, 16], // +Y: u = z, v = x
    [3, 0, 0, 0, 16, 16], // -Y: u = x, v = z
    [4, 16, 0, 0, 16, 8], // +Z: u = x, v = y
    [5, 0, 0, 0, 8, 16], // -Z: u = y, v = x
  ].flatMap((r) => [...r, 6, 1]),
  tris: [],
};

/**
 * A fence-like joining model: a post face on top, and for each joined side a rail end on
 * that side of the cell (bit 0 north -Z, 1 east +X, 2 south +Z, 3 west -X).
 */
function fenceShape(): ModelShape {
  const ends = [
    [5, 0, 12, 7, 15, 9], // north: u = y, v = x
    [0, 16, 12, 7, 15, 9], // east: u = y, v = z
    [4, 16, 7, 12, 9, 15], // south: u = x, v = y
    [1, 0, 7, 12, 9, 15], // west: u = z, v = y
  ];
  const variants = Array.from({ length: 16 }, (_, mask) => ({
    rects: [[2, 16, 6, 6, 10, 10], ...ends.filter((_, bit) => mask & (1 << bit))].flatMap((r) => [
      ...r,
      6,
      1,
    ]),
    tris: [],
  }));
  return { variants, group: 1, joins: 1 };
}

function mesh(world: World, models: Record<number, ModelShape>) {
  const table = ShapeTable.of(world.states);
  const byId: (ModelShape | null)[] = [];
  for (const [semantic, model] of Object.entries(models))
    byId[world.states.intern({ semantic: Number(semantic) })] = model;
  table.setModels(byId);
  const L = world.layout;
  const cells = world.copyPadded(0, 0, 0, new Uint16Array(paddedVolume(L.bits)));
  const m = meshChunk({ bits: L.bits, cells, lightBrickBits: null }, table);
  return Array.from({ length: m.quadCount }, (_, q) => {
    const at = (i: number) => m.quads[q * QUAD_WORDS + i] ?? 0;
    return { x: at(0), y: at(1), z: at(2), face: at(3), w: at(4), h: at(5), slot: at(7) };
  });
}

describe("block models", () => {
  it("draws a slab's faces in sixteenths, with their material slot", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 1, 1, { semantic: SLAB });
    const quads = mesh(world, { [SLAB]: { variants: [SLAB_FACES], group: 0, joins: 0 } });
    expect(quads.length).toBe(6);
    expect(quads.every((q) => q.slot === 6)).toBe(true);
    expect(quads.find((q) => q.face === 2)?.y).toBe(16 + 8);
  });

  it("hides what a slab covers, and only that", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 0, 1, { semantic: MASS });
    world.set(1, 1, 1, { semantic: SLAB });
    world.set(1, 2, 1, { semantic: MASS });
    const quads = mesh(world, { [SLAB]: { variants: [SLAB_FACES], group: 0, joins: 0 } });
    // The cube below loses its top and the slab its bottom; the cube above keeps its bottom.
    expect(quads.filter((q) => q.face === 2 && q.y === 16).length).toBe(0);
    expect(quads.filter((q) => q.face === 3 && q.y === 16).length).toBe(0);
    expect(quads.filter((q) => q.face === 3 && q.y === 32).length).toBe(1);
  });

  it("hides the sides two slabs share and merges their tops", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 1, 1, { semantic: SLAB });
    world.set(2, 1, 1, { semantic: SLAB });
    const quads = mesh(world, { [SLAB]: { variants: [SLAB_FACES], group: 0, joins: 0 } });
    expect(quads.filter((q) => q.face === 0 || q.face === 1).length).toBe(2);
    const top = quads.filter((q) => q.face === 2);
    expect(top.length).toBe(1);
    expect(top[0]?.h).toBe(32); // +Y's V axis is x: two cells long
  });

  it("joins neighbours of its group and whole cubes, hiding the ends that meet", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 1, 2, { semantic: FENCE });
    world.set(1, 1, 1, { semantic: FENCE }); // north of the first
    world.set(2, 1, 2, { semantic: MASS }); // east of the first
    const quads = mesh(world, { [FENCE]: fenceShape() });
    // Two post tops; the rail ends meeting between the fences hide each other, and the end
    // against the cube hides behind it.
    expect(quads.filter((q) => q.face === 2 && q.y === 32 && q.x === 16 + 6).length).toBe(2);
    const ends = quads.filter((q) => q.y === 16 + 12 || (q.face >= 4 && q.y === 16 + 7));
    expect(ends.length).toBe(0);
  });

  it("drops a model when the looks drop it, back to a whole cube", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 1, 1, { semantic: SLAB });
    const table = ShapeTable.of(world.states);
    const id = world.states.intern({ semantic: SLAB });
    const models: (ModelShape | null)[] = [];
    models[id] = { variants: [SLAB_FACES], group: 0, joins: 0 };
    table.setModels(models);
    expect(table.shaped[id]).toBe(1);
    table.setModels([]);
    expect(table.shaped[id]).toBe(0);
    expect(table.cube[id]).toBe(1);
  });
});
