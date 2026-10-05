import { chunkKey, chunkKeyToCoords, World } from "@voxyl/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FACES, meshChunk, paddedVolume, QUAD_BYTES } from "../src/index.ts";

interface Quad {
  x: number;
  y: number;
  z: number;
  face: number;
  w: number;
  h: number;
  id: number;
}

function quadsOf(mesh: { quads: Uint8Array; quadCount: number }): Quad[] {
  const { quads, quadCount } = mesh;
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
    };
  });
}

/** Meshes chunk [0,0,0] of a world. */
function meshOrigin(world: World) {
  const L = world.layout;
  const cells = world.copyPadded(0, 0, 0, new Uint16Array(paddedVolume(L.bits)));
  return quadsOf(meshChunk({ bits: L.bits, cells, lightBrickBits: null }));
}

describe("meshChunk", () => {
  it("covers a solid chunk with one quad per face", () => {
    const world = new World({ chunkBits: 3 });
    world.fillBox(0, 0, 0, 7, 7, 7, world.states.intern({ semantic: "Mass" }));
    const quads = meshOrigin(world);
    expect(quads.length).toBe(6);
    for (const q of quads) expect([q.w, q.h]).toEqual([8, 8]);
  });

  it("hides faces that touch neighbouring chunks", () => {
    const world = new World({ chunkBits: 3 });
    world.fillBox(-8, -8, -8, 15, 15, 15, world.states.intern({ semantic: "Mass" }));
    expect(meshOrigin(world).length).toBe(0);
  });

  it("does not merge faces of different cell states", () => {
    const world = new World({ chunkBits: 3 });
    world.set(0, 0, 0, { semantic: "Mass" });
    world.set(1, 0, 0, { semantic: "Trim" });
    expect(meshOrigin(world).length).toBe(10);
    world.set(1, 0, 0, { semantic: "Mass" });
    expect(meshOrigin(world).length).toBe(6);
  });

  it("encodes state ids above 255", () => {
    const world = new World({ chunkBits: 3 });
    for (let i = 0; i < 0x1234; i++) world.states.intern({ semantic: `S${i}` });
    world.setId(0, 0, 0, 0x1234);
    expect(meshOrigin(world)[0]?.id).toBe(0x1234);
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
  const cells = new Uint16Array(paddedVolume(L.bits));
  for (const key of world.chunkKeys()) {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    world.copyPadded(cx, cy, cz, cells);
    for (const q of quadsOf(meshChunk({ bits: L.bits, cells, lightBrickBits: null }))) {
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

const coord = fc.integer({ min: -12, max: 12 });
const boxArb = fc.record({
  a: fc.tuple(coord, coord, coord),
  size: fc.tuple(fc.nat(6), fc.nat(6), fc.nat(6)),
  s: fc.constantFrom("Mass", "Trim", null),
});

type Box = typeof boxArb extends fc.Arbitrary<infer T> ? T : never;

function worldOf(chunkBits: number, boxes: readonly Box[]) {
  const world = new World({ chunkBits });
  for (const { a, size, s } of boxes) {
    const id = s === null ? 0 : world.states.intern({ semantic: s });
    world.fillBox(a[0], a[1], a[2], a[0] + size[0], a[1] + size[1], a[2] + size[2], id);
  }
  return world;
}

describe.each([3, 4])("meshing a world of %i-bit chunks", (chunkBits) => {
  it("covers exactly the exposed faces, each with its cell's state", () => {
    fc.assert(
      fc.property(fc.array(boxArb, { maxLength: 12 }), (boxes) => {
        const world = worldOf(chunkBits, boxes);
        expect(meshedFaces(world)).toEqual(exposedFaces(world));
      }),
      { numRuns: 60 },
    );
  });

  it("lists exactly the light bricks the faces read", () => {
    const brickBits = 2;
    const B = 1 << brickBits;
    fc.assert(
      fc.property(fc.array(boxArb, { maxLength: 10 }), (boxes) => {
        const world = worldOf(chunkBits, boxes);
        const S = world.layout.size;
        const n = S / B;
        const NB = n + 2;
        // The slow way: every face's front cell and its 8 neighbours in the face's plane.
        const want = new Map<number, Set<number>>();
        for (const key of world.chunkKeys()) want.set(key, new Set());
        world.forEachCell((x, y, z) => {
          for (const face of FACES) {
            const front = [x, y, z];
            front[face.axis] = (front[face.axis] ?? 0) + face.sign;
            if (world.getId(front[0] ?? 0, front[1] ?? 0, front[2] ?? 0) !== 0) continue;
            const cell = [x, y, z].map((c) => Math.floor(c / S));
            const list = want.get(chunkKeyOf(cell));
            for (let du = -1; du <= 1; du++) {
              for (let dv = -1; dv <= 1; dv++) {
                const s = [...front];
                s[face.u] = (s[face.u] ?? 0) + du;
                s[face.v] = (s[face.v] ?? 0) + dv;
                const b = s.map((c, i) => Math.floor((c - (cell[i] ?? 0) * S) / B) + 1);
                list?.add((b[0] ?? 0) + (b[2] ?? 0) * NB + (b[1] ?? 0) * NB * NB);
              }
            }
          }
        });
        const cells = new Uint16Array(paddedVolume(chunkBits));
        for (const key of world.chunkKeys()) {
          const [cx, cy, cz] = chunkKeyToCoords(key);
          world.copyPadded(cx, cy, cz, cells);
          const mesh = meshChunk({ bits: chunkBits, cells, lightBrickBits: brickBits });
          expect([...mesh.lightBricks]).toEqual([...(want.get(key) ?? [])].sort((p, q) => p - q));
        }
      }),
      { numRuns: 40 },
    );
  });
});

/** chunkKey for [cx, cy, cz], via the core's packing. */
function chunkKeyOf(c: number[]): number {
  return chunkKey(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
}
