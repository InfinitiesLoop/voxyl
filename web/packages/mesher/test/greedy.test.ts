import { chunkKeyToCoords, World } from "@voxyl/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FACES, meshChunk, paddedVolume, QUAD_BYTES } from "../src/index.ts";

const SKY = 0xf000;

interface Quad {
  x: number;
  y: number;
  z: number;
  face: number;
  w: number;
  h: number;
  id: number;
  /** [sky, r, g, b] per corner. */
  corners: number[][];
}

function quadsOf(quads: Uint8Array, quadCount: number): Quad[] {
  return Array.from({ length: quadCount }, (_, q) => {
    const at = (i: number) => quads[q * QUAD_BYTES + i] ?? 0;
    return {
      x: at(0),
      y: at(1),
      z: at(2),
      face: at(3),
      w: at(4),
      h: at(5),
      id: at(6) | (at(7) << 8),
      corners: [0, 1, 2, 3].map((k) => [
        at(8 + k * 4),
        at(9 + k * 4),
        at(10 + k * 4),
        at(11 + k * 4),
      ]),
    };
  });
}

/** Meshes chunk [0,0,0] of a world, with every cell given `light` and every state opaque. */
function meshOrigin(world: World, light: ((x: number, y: number, z: number) => number) | null) {
  const L = world.layout;
  const P = L.size + 2;
  const cells = world.copyPadded(0, 0, 0, new Uint16Array(paddedVolume(L.bits)));
  let lightArray: Uint16Array | null = null;
  if (light) {
    lightArray = new Uint16Array(cells.length);
    for (let y = -1; y <= L.size; y++)
      for (let z = -1; z <= L.size; z++)
        for (let x = -1; x <= L.size; x++)
          lightArray[x + 1 + (z + 1) * P + (y + 1) * P * P] = light(x, y, z);
  }
  const opaque = new Uint8Array(world.states.size + 1).fill(1);
  opaque[0] = 0;
  const { quads, quadCount } = meshChunk({ bits: L.bits, cells, light: lightArray, opaque });
  return quadsOf(quads, quadCount);
}

describe("meshChunk", () => {
  it("covers a solid chunk with one quad per face", () => {
    const world = new World({ chunkBits: 3 });
    world.fillBox(0, 0, 0, 7, 7, 7, world.states.intern({ semantic: "Mass" }));
    const quads = meshOrigin(world, null);
    expect(quads.length).toBe(6);
    for (const q of quads) expect([q.w, q.h]).toEqual([8, 8]);
  });

  it("hides faces that touch neighbouring chunks", () => {
    const world = new World({ chunkBits: 3 });
    world.fillBox(-8, -8, -8, 15, 15, 15, world.states.intern({ semantic: "Mass" }));
    expect(meshOrigin(world, null).length).toBe(0);
  });

  it("does not merge faces of different cell states", () => {
    const world = new World({ chunkBits: 3 });
    world.set(0, 0, 0, { semantic: "Mass" });
    world.set(1, 0, 0, { semantic: "Trim" });
    expect(meshOrigin(world, null).length).toBe(10);
    world.set(1, 0, 0, { semantic: "Mass" });
    expect(meshOrigin(world, null).length).toBe(6);
  });

  it("encodes state ids above 255", () => {
    const world = new World({ chunkBits: 3 });
    for (let i = 0; i < 0x1234; i++) world.states.intern({ semantic: `S${i}` });
    world.setId(0, 0, 0, 0x1234);
    expect(meshOrigin(world, null)[0]?.id).toBe(0x1234);
  });

  it("gives every corner full light when lighting is off", () => {
    const world = new World({ chunkBits: 3 });
    world.set(2, 2, 2, { semantic: "Mass" });
    for (const q of meshOrigin(world, null)) {
      for (const c of q.corners) expect(c).toEqual([255, 255, 255, 255]);
    }
  });

  it("averages the light of the cells around each corner", () => {
    const world = new World({ chunkBits: 3 });
    world.set(2, 2, 2, { semantic: "Mass" });
    // Sky 15 for x < 3, sky 7 beyond: the top face's corners on the x+ side average the two.
    const quads = meshOrigin(world, (x) => (x < 3 ? SKY : 0x7000));
    const top = quads.find((q) => q.face === 2);
    // +Y face: U is +Z, V is +X, so corners 2 and 3 (V = 1) sit on the x = 3 edge.
    expect(top?.corners[0]?.[0]).toBe(255);
    expect(top?.corners[2]?.[0]).toBe(Math.round(((15 + 15 + 7 + 7) / 4) * 17));
  });

  it("darkens corners boxed in by neighbouring blocks (ambient occlusion)", () => {
    const world = new World({ chunkBits: 3 });
    const mass = world.states.intern({ semantic: "Mass" });
    world.fillBox(0, 0, 0, 4, 0, 4, mass); // a floor
    world.setId(2, 1, 2, mass); // a block standing on it
    const quads = meshOrigin(world, () => SKY);
    // The floor's top faces next to the block have darkened corners and can't all merge.
    const floorTop = quads.filter((q) => q.face === 2 && q.y === 0);
    expect(floorTop.length).toBeGreaterThan(1);
    const darkest = Math.min(...floorTop.flatMap((q) => q.corners.map((c) => c[0] ?? 0)));
    expect(darkest).toBeLessThan(255);
    // Far from the block the floor stays fully lit.
    expect(floorTop.some((q) => q.corners.every((c) => c[0] === 255))).toBe(true);
  });

  it("colours block light per channel", () => {
    const world = new World({ chunkBits: 3 });
    world.set(2, 2, 2, { semantic: "Mass" });
    const quads = meshOrigin(world, () => 0x0f80); // no sky, red 15, green 8, blue 0
    for (const c of quads[0]?.corners ?? []) expect(c).toEqual([0, 255, 136, 0]);
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
function meshedFaces(world: World, lit: boolean): Map<string, number> {
  const L = world.layout;
  const faces = new Map<string, number>();
  const cells = new Uint16Array(paddedVolume(L.bits));
  const opaque = new Uint8Array(world.states.size + 1).fill(1);
  opaque[0] = 0;
  for (const key of world.chunkKeys()) {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    world.copyPadded(cx, cy, cz, cells);
    // Arbitrary light that varies from cell to cell, to exercise merging around gradients.
    const light = lit ? cells.map((_, i) => ((i * 2654435761) >>> 0) & 0xf0f0) : null;
    const { quads, quadCount } = meshChunk({ bits: L.bits, cells, light, opaque });
    for (const q of quadsOf(quads, quadCount)) {
      const face = FACES[q.face];
      if (!face) throw new Error(`bad face ${q.face}`);
      for (let du = 0; du < q.w; du++) {
        for (let dv = 0; dv < q.h; dv++) {
          const p = [q.x, q.y, q.z];
          p[face.u] = (p[face.u] ?? 0) + du;
          p[face.v] = (p[face.v] ?? 0) + dv;
          const k = `${q.face},${cx * L.size + (p[0] ?? 0)},${cy * L.size + (p[1] ?? 0)},${cz * L.size + (p[2] ?? 0)}`;
          expect(faces.has(k), `face ${k} covered twice`).toBe(false);
          faces.set(k, q.id);
        }
      }
    }
  }
  return faces;
}

describe.each([
  [3, false],
  [4, false],
  [3, true],
])("meshing a world of %i-bit chunks (lit: %s)", (chunkBits, lit) => {
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
        expect(meshedFaces(world, lit)).toEqual(exposedFaces(world));
      }),
      { numRuns: 60 },
    );
  });
});
