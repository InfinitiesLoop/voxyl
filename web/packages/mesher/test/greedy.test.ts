import { chunkKeyToCoords, World } from "@voxyl/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extractSlab, FACES, meshChunk, QUAD_BYTES } from "../src/index.ts";

const NO_NEIGHBORS = [null, null, null, null, null, null];

describe("meshChunk", () => {
  it("covers a solid chunk with one quad per face", () => {
    const bits = 3;
    const cells = new Uint16Array(512).fill(1);
    const { quads, quadCount } = meshChunk({ bits, cells, neighbors: NO_NEIGHBORS });
    expect(quadCount).toBe(6);
    for (let q = 0; q < quadCount; q++) {
      expect(quads[q * QUAD_BYTES + 4]).toBe(8);
      expect(quads[q * QUAD_BYTES + 5]).toBe(8);
    }
  });

  it("hides faces that touch full neighbouring layers", () => {
    const bits = 3;
    const cells = new Uint16Array(512).fill(1);
    const full = new Uint16Array(64).fill(2);
    expect(meshChunk({ bits, cells, neighbors: FACES.map(() => full) }).quadCount).toBe(0);
  });

  it("does not merge faces of different cell states", () => {
    const bits = 3;
    const cells = new Uint16Array(512);
    cells[0] = 1;
    cells[1] = 2;
    // Two adjacent cubes: 10 exposed faces, nothing merges across the two ids.
    expect(meshChunk({ bits, cells, neighbors: NO_NEIGHBORS }).quadCount).toBe(10);
    cells[1] = 1;
    // Same id: the four long sides and the two ends merge to 6 quads.
    expect(meshChunk({ bits, cells, neighbors: NO_NEIGHBORS }).quadCount).toBe(6);
  });

  it("encodes state ids above 255", () => {
    const cells = new Uint16Array(512);
    cells[0] = 0x1234;
    const { quads } = meshChunk({ bits: 3, cells, neighbors: NO_NEIGHBORS });
    expect((quads[6] ?? 0) | ((quads[7] ?? 0) << 8)).toBe(0x1234);
  });
});

/** Every visible face as "face,x,y,z", found by checking each cell's six neighbours. */
function exposedFaces(world: World): Map<string, number> {
  const faces = new Map<string, number>();
  world.forEachCell((x, y, z, id) => {
    FACES.forEach((face, f) => {
      const n = [x, y, z];
      n[face.axis] = (n[face.axis] ?? 0) + face.sign;
      if (world.getId(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) === 0) {
        faces.set(`${f},${x},${y},${z}`, id);
      }
    });
  });
  return faces;
}

/** Meshes every chunk the way the renderer does and expands the quads back into faces. */
function meshedFaces(world: World): Map<string, number> {
  const L = world.layout;
  const faces = new Map<string, number>();
  for (const key of world.chunkKeys()) {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    const chunk = world.chunk(cx, cy, cz);
    if (!chunk) continue;
    const neighbors = FACES.map((face, f) => {
      const c = [cx, cy, cz];
      c[face.axis] = (c[face.axis] ?? 0) + face.sign;
      const neighbor = world.chunk(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
      return neighbor ? extractSlab(neighbor.cells, L.bits, f) : null;
    });
    const { quads, quadCount } = meshChunk({ bits: L.bits, cells: chunk.cells, neighbors });
    for (let q = 0; q < quadCount; q++) {
      const o = q * QUAD_BYTES;
      const at = (i: number) => quads[o + i] ?? 0;
      const f = at(3);
      const face = FACES[f];
      if (!face) throw new Error(`bad face ${f}`);
      const id = at(6) | (at(7) << 8);
      for (let du = 0; du < at(4); du++) {
        for (let dv = 0; dv < at(5); dv++) {
          const p = [at(0), at(1), at(2)];
          p[face.u] = (p[face.u] ?? 0) + du;
          p[face.v] = (p[face.v] ?? 0) + dv;
          const k = `${f},${cx * L.size + (p[0] ?? 0)},${cy * L.size + (p[1] ?? 0)},${cz * L.size + (p[2] ?? 0)}`;
          expect(faces.has(k), `face ${k} covered twice`).toBe(false);
          faces.set(k, id);
        }
      }
    }
  }
  return faces;
}

describe.each([3, 4])("meshing a world of %i-bit chunks", (chunkBits) => {
  it("covers exactly the exposed faces, each with its cell's state", () => {
    const coord = fc.integer({ min: -12, max: 12 });
    const box = fc.record({
      a: fc.tuple(coord, coord, coord),
      size: fc.tuple(fc.nat(6), fc.nat(6), fc.nat(6)),
      s: fc.constantFrom("Mass", "Trim", null),
    });
    fc.assert(
      fc.property(fc.array(box, { maxLength: 12 }), (boxes) => {
        const world = new World({ chunkBits });
        for (const { a, size, s } of boxes) {
          const id = s === null ? 0 : world.states.intern({ semantic: s });
          world.fillBox(a[0], a[1], a[2], a[0] + size[0], a[1] + size[1], a[2] + size[2], id);
        }
        expect(meshedFaces(world)).toEqual(exposedFaces(world));
      }),
      { numRuns: 80 },
    );
  });
});
