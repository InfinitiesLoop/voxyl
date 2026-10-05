import { type CellStateInput, World } from "@voxyl/core";
import { archSlot } from "@voxyl/shapes";
import { describe, expect, it } from "vitest";
import {
  FACES,
  meshChunk,
  paddedVolume,
  QUAD_WORDS,
  ShapeTable,
  TRI_SCALE,
  TRI_WORDS,
} from "../src/index.ts";

const part = (shape: string, slot: number, semantic = "Trim"): CellStateInput => ({
  parts: [{ semantic, shape, slot }],
});

function meshOrigin(world: World) {
  const L = world.layout;
  const cells = world.copyPadded(0, 0, 0, new Uint16Array(paddedVolume(L.bits)));
  return meshChunk({ bits: L.bits, cells, lightBrickBits: null }, ShapeTable.of(world.states));
}

/** Quads as [face, x, y, z, w, h] in eighths of a cell. */
function quads(mesh: ReturnType<typeof meshOrigin>) {
  return Array.from({ length: mesh.quadCount }, (_, q) => {
    const at = (i: number) => mesh.quads[q * QUAD_WORDS + i] ?? 0;
    return [at(3), at(0), at(1), at(2), at(4), at(5)];
  });
}

/** Total area in square eighths, per face. */
function areaByFace(mesh: ReturnType<typeof meshOrigin>): number[] {
  const area = [0, 0, 0, 0, 0, 0];
  for (const [f, , , , w, h] of quads(mesh))
    area[f ?? 0] = (area[f ?? 0] ?? 0) + (w ?? 0) * (h ?? 0);
  return area;
}

describe("shaped parts", () => {
  it("draws a cover as six faces of its box", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 1, 1, part("face1", 0)); // against -Y, 1/8 thick
    const mesh = meshOrigin(world);
    expect(mesh.quadCount).toBe(6);
    // +X, -X, +Y, -Y, +Z, -Z: the sides are 8 x 1, top and bottom 8 x 8.
    expect(areaByFace(mesh)).toEqual([8, 8, 64, 64, 8, 8]);
    const top = quads(mesh).find(([f]) => f === 2);
    expect(top?.[2]).toBe(8 + 1); // y of the top face: cell 1, one eighth up
  });

  it("colours each part by its own semantic", () => {
    const world = new World({ chunkBits: 3 });
    world.set(0, 0, 0, part("face1", 0, "Roof"));
    const roof = world.states.intern({ semantic: "Roof" });
    const mesh = meshOrigin(world);
    for (let q = 0; q < mesh.quadCount; q++) expect(mesh.quads[q * QUAD_WORDS + 6]).toBe(roof);
  });

  it("hides faces between a cover and the cube it lies on", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 0, 1, { semantic: "Mass" });
    world.set(1, 1, 1, part("face1", 0));
    // The cube loses its top, the cover its bottom.
    expect(meshOrigin(world).quadCount).toBe(10);
  });

  it("keeps a cube's face beside a part that covers only some of it", () => {
    const world = new World({ chunkBits: 3 });
    world.set(1, 0, 1, { semantic: "Mass" });
    world.set(1, 1, 1, part("edge1", 8)); // a strip along X on the bottom -Z edge
    const area = areaByFace(meshOrigin(world));
    expect(area[2]).toBe(64 + 8); // the cube's whole top, and the strip's top
  });

  it("merges a run of strips into one long quad per side", () => {
    const world = new World({ chunkBits: 3 });
    for (let x = 0; x < 5; x++) world.set(x, 2, 2, part("edge1", 8));
    const mesh = meshOrigin(world);
    // Four long sides and two end caps; the faces between strips are hidden.
    expect(mesh.quadCount).toBe(6);
    const long = quads(mesh).filter(([f]) => f !== 0 && f !== 1);
    for (const q of long) expect(Math.max(q[4] ?? 0, q[5] ?? 0)).toBe(40);
  });

  it("hides a hollow cover's sides against its neighbours", () => {
    const world = new World({ chunkBits: 3 });
    world.set(0, 0, 0, part("hollow1", 0));
    world.set(1, 0, 0, part("hollow1", 0));
    const alone = new World({ chunkBits: 3 });
    alone.set(0, 0, 0, part("hollow1", 0));
    const one = areaByFace(meshOrigin(alone));
    const two = areaByFace(meshOrigin(world));
    // The touching +X and -X rims (8 x 1 each) are gone.
    expect(two[0]).toBe((one[0] ?? 0) * 2 - 8);
    expect(two[1]).toBe((one[1] ?? 0) * 2 - 8);
  });

  it("culls a roof tile's bottom on a cube and the sides between tiles", () => {
    const world = new World({ chunkBits: 3 });
    world.set(0, 0, 0, part("roof_tile", archSlot(0, 0), "Roof"));
    const alone = meshOrigin(world).triCount;
    expect(alone).toBe(8); // slope 2, side triangles 2, bottom 2, back 2

    world.set(0, -1, 0, { semantic: "Mass" });
    expect(meshOrigin(world).triCount).toBe(6);

    world.set(1, 0, 0, part("roof_tile", archSlot(0, 0), "Roof"));
    world.set(1, -1, 0, { semantic: "Mass" });
    expect(meshOrigin(world).triCount).toBe(10);
  });

  it("winds roof triangles to face out of the shape", () => {
    const world = new World({ chunkBits: 3 });
    world.set(0, 0, 0, part("roof_tile", archSlot(0, 0), "Roof"));
    const mesh = meshOrigin(world);
    // A point inside the wedge: under the slope, which rises from the front (-Z) to the back.
    const centre = [TRI_SCALE / 2, TRI_SCALE / 4, (TRI_SCALE * 3) / 4];
    for (let t = 0; t < mesh.triCount; t++) {
      const p = [0, 1, 2].map((k) =>
        [0, 1, 2].map((c) => mesh.tris[t * TRI_WORDS + k * 4 + c] ?? 0),
      ) as number[][];
      const [a, b, c] = p as [number[], number[], number[]];
      const e1 = a.map((v, i) => (b[i] ?? 0) - v);
      const e2 = a.map((v, i) => (c[i] ?? 0) - v);
      const n = [
        (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
        (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
        (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
      ];
      // The wedge is convex, so every face looks away from a point inside it.
      const mid = [0, 1, 2].map((i) => ((a[i] ?? 0) + (b[i] ?? 0) + (c[i] ?? 0)) / 3);
      const out = n.reduce((s, v, i) => s + v * ((mid[i] ?? 0) - (centre[i] ?? 0)), 0);
      expect(out).toBeGreaterThan(0);
    }
  });

  it("draws unknown shapes as whole cubes", () => {
    const world = new World({ chunkBits: 3 });
    world.set(0, 0, 0, part("no_such_shape", 0));
    const mesh = meshOrigin(world);
    expect(mesh.quadCount).toBe(6);
    expect(areaByFace(mesh)).toEqual(FACES.map(() => 64));
  });
});
