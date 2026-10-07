import { compose, IDENTITY, rotate, rotationFacing, turn, turnClockwise } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  buildDefaultLibrary,
  compileBlock,
  compileShape,
  DEFAULT_TEXTURE_KEYS,
  type Element,
  faceUvMap,
  JOIN_FENCE,
  JOIN_PANE,
  JOIN_WALL,
  type Library,
  paintTexture,
  placeBlock,
  variantFor,
  variantRotation,
} from "../src/index.ts";

const library = buildDefaultLibrary();
const libraries = new Map<string, Library>([[library.id, library]]);

/** Applies a [a00, a01, a02, b0, a10, a11, a12, b1] uv map to a cell point. */
function uvOf(map: Float32Array, q: [number, number, number]): [number, number] {
  const at = (i: number) => map[i] ?? 0;
  return [
    at(0) * q[0] + at(1) * q[1] + at(2) * q[2] + at(3),
    at(4) * q[0] + at(5) * q[1] + at(6) * q[2] + at(7),
  ];
}

const close = (a: readonly number[], b: readonly number[]) => {
  for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] ?? Number.NaN, 5);
};

describe("variant rotations", () => {
  it("turns as Minecraft does: y clockwise from above, x taking a front up at 270", () => {
    expect(rotate(variantRotation({ model: "m", y: 90 }), [1, 0, 0])).toEqual([0, 0, 1]);
    expect(rotate(variantRotation({ model: "m", x: 270 }), [0, 0, -1])).toEqual([0, 1, 0]);
    expect(rotate(variantRotation({ model: "m", x: 90 }), [0, 0, -1])).toEqual([0, -1, 0]);
  });

  it("picks the stairs variant that faces and stands like the cell", () => {
    const stairs = library.blocks.oak_stairs;
    if (!stairs) throw new Error("no oak stairs");
    expect(variantFor(stairs, IDENTITY)).toEqual(
      stairs.variants?.["facing=north,half=bottom,shape=straight"],
    );
    const east = turnClockwise(1);
    expect(variantFor(stairs, east)).toEqual(
      stairs.variants?.["facing=east,half=bottom,shape=straight"],
    );
    const upsideDown = rotationFacing([0, 0, -1], [0, -1, 0]);
    expect(variantFor(stairs, upsideDown)).toEqual(
      stairs.variants?.["facing=north,half=top,shape=straight"],
    );
  });

  it("picks a log's axis from the cell's top, whichever way it spins", () => {
    const log = library.blocks.oak_log;
    if (!log) throw new Error("no oak log");
    for (const spin of [0, 1, 2, 3]) {
      const lyingX = compose(turn(2, 1), turn(1, spin)); // top along -X
      expect(variantFor(log, lyingX)).toEqual(log.variants?.["axis=x"]);
      const lyingZ = compose(turn(0, 1), turn(1, spin));
      expect(variantFor(log, lyingZ)).toEqual(log.variants?.["axis=z"]);
    }
  });

  it("draws a fence's post always and a side for each connection", () => {
    const fence = library.blocks.oak_fence;
    if (!fence) throw new Error("no oak fence");
    expect(placeBlock(fence, IDENTITY).map((p) => p.model)).toEqual(["oak_fence_post"]);
    const both = placeBlock(fence, IDENTITY, { north: "true", west: "true" });
    expect(both.map((p) => p.model)).toEqual([
      "oak_fence_post",
      "oak_fence_side",
      "oak_fence_side",
    ]);
  });
});

describe("face uvs", () => {
  const full: Element = {
    from: [0, 0, 0],
    to: [16, 16, 16],
    faces: { north: { texture: "t" }, up: { texture: "t" } },
  };

  it("maps a north face as Minecraft does: u from east to west, v from top to bottom", () => {
    const map = faceUvMap(full, "north", { texture: "t" }, IDENTITY, false);
    close(uvOf(map, [1, 1, 0]), [0, 0]);
    close(uvOf(map, [0, 0, 0]), [1, 1]);
  });

  it("turns a face's texture clockwise", () => {
    const map = faceUvMap(full, "up", { texture: "t", rotation: 90 }, IDENTITY, false);
    // Unturned, the top's corner at x = 1, z = 0 shows texture (1, 0); turned, (0, 0).
    close(uvOf(map, [1, 1, 0]), [0, 0]);
  });

  it("carries a texture round with its model, unless uvlock keeps it to the world", () => {
    const east = turnClockwise(1);
    // The model's north face now faces east; its texture's left edge follows it.
    const turned = faceUvMap(full, "north", { texture: "t" }, east, false);
    close(uvOf(turned, [1, 1, 1]), [0, 0]);
    const locked = faceUvMap(full, "up", { texture: "t" }, east, true);
    close(uvOf(locked, [0.25, 1, 0.75]), [0.25, 0.75]);
  });
});

describe("the default library", () => {
  it("paints the same pixels every time, 16 x 16", () => {
    for (const key of DEFAULT_TEXTURE_KEYS) {
      const a = paintTexture(key);
      expect(a.size).toBe(16);
      expect(a.rgba.length).toBe(16 * 16 * 4);
      expect(paintTexture(key).rgba).toEqual(a.rgba);
    }
    expect(paintTexture("glass").alpha).toBe("cutout");
    expect(paintTexture("stone").alpha).toBe("opaque");
  });

  it("has every model and texture its blocks name", () => {
    for (const [name, block] of Object.entries(library.blocks)) {
      const variants = [
        ...Object.values(block.variants ?? {}),
        ...(block.multipart ?? []).map((p) => p.apply),
      ];
      expect(variants.length, name).toBeGreaterThan(0);
      for (const v of variants) {
        const model = library.models[v.model];
        expect(model, `${name} -> ${v.model}`).toBeDefined();
        for (const e of model?.elements ?? [])
          for (const face of Object.values(e.faces))
            expect(library.textures[face.texture], `${v.model}: ${face.texture}`).toBeDefined();
      }
    }
  });

  it("compiles whole cubes to six textured faces, and other shapes to none", () => {
    const stone = compileBlock(libraries, "voxyl:stone", IDENTITY);
    expect(stone?.cube?.every((f) => f?.texture === "voxyl:stone")).toBe(true);
    expect(stone?.transparent).toBe(false);
    expect(compileBlock(libraries, "voxyl:glass", IDENTITY)?.transparent).toBe(true);
    expect(compileBlock(libraries, "voxyl:oak_slab", IDENTITY)?.cube).toBeNull();
    expect(compileBlock(libraries, "voxyl:nothing", IDENTITY)).toBeNull();
    expect(compileBlock(libraries, "minecraft:stone", IDENTITY)).toBeNull();
    // A log on its side shows its rings east and west.
    const log = compileBlock(libraries, "voxyl:oak_log", compose(turn(2, 1), IDENTITY));
    expect(log?.cube?.[0]?.texture).toBe("voxyl:oak_log_top");
    expect(log?.cube?.[2]?.texture).toBe("voxyl:oak_log");
  });
});

describe("block shapes", () => {
  it("places a slab's faces in sixteenths, its top halfway up", () => {
    const slab = compileShape(libraries, "voxyl:oak_slab", IDENTITY);
    expect(slab?.variants.length).toBe(1);
    const faces = slab?.variants[0] ?? [];
    expect(faces.length).toBe(6);
    const up = faces.find((f) => f.side === "up");
    expect(up?.corners.every((c) => c[1] === 8)).toBe(true);
    expect(up?.face.texture).toBe("voxyl:oak_planks");
    // Parts drawn in a slab's look take its faces by side.
    expect(slab?.sides.every((f) => f !== null)).toBe(true);
  });

  it("turns stairs with the cell, upside down too", () => {
    const upsideDown = rotationFacing([0, 0, -1], [0, -1, 0]);
    const stairs = compileShape(libraries, "voxyl:oak_stairs", upsideDown);
    const faces = stairs?.variants[0] ?? [];
    // The full-width half is now on top: its up face lies on the cell's top.
    const top = faces.filter((f) => f.side === "up").map((f) => f.corners[0][1]);
    expect(top).toContain(16);
    const bottom = faces.filter((f) => f.side === "down").map((f) => f.corners[0][1]);
    expect(bottom).toContain(8);
  });

  it("gives a joining block one set of faces per mask of joined sides", () => {
    const fence = compileShape(libraries, "voxyl:oak_fence", IDENTITY);
    expect(fence?.variants.length).toBe(16);
    expect(fence?.group).toBe(JOIN_FENCE);
    expect(fence?.joins).toBe(JOIN_FENCE);
    const post = fence?.variants[0] ?? [];
    expect(post.length).toBe(6);
    // Joined north: two rails reach the north edge of the cell.
    const north = fence?.variants[1] ?? [];
    const reaching = north.filter((f) => f.side === "north" && f.corners[0][2] === 0);
    expect(reaching.length).toBe(2);
    const pane = compileShape(libraries, "voxyl:glass_pane", IDENTITY);
    expect(pane?.group).toBe(JOIN_PANE);
    expect(pane?.joins).toBe(JOIN_PANE | JOIN_WALL);
    expect(compileShape(libraries, "voxyl:nothing", IDENTITY)).toBeNull();
  });

  it("draws a turned element as a diagonal face that still maps its whole texture", () => {
    const plants: Library = {
      id: "plants",
      name: "Plants",
      textures: { flower: paintTexture("glass") },
      models: {
        cross: {
          elements: [
            {
              from: [0.8, 0, 8],
              to: [15.2, 16, 8],
              rotation: { origin: [8, 8, 8], axis: "y", angle: 45, rescale: true },
              faces: {
                north: { texture: "flower", uv: [0, 0, 16, 16] },
                south: { texture: "flower", uv: [0, 0, 16, 16] },
              },
            },
          ],
        },
      },
      blocks: { flower: { variants: { "": { model: "cross" } }, color: "#ff0000" } },
    };
    const shape = compileShape(new Map([["plants", plants]]), "plants:flower", IDENTITY);
    const faces = shape?.variants[0] ?? [];
    expect(faces.length).toBe(2);
    for (const face of faces) {
      expect(face.side).toBeNull();
      // Stretched corner to corner across the cell.
      const xs = face.corners.map((c) => c[0]);
      expect(Math.min(...xs)).toBeCloseTo(0.8, 3);
      expect(Math.max(...xs)).toBeCloseTo(15.2, 3);
      const us = face.corners.map((c) => uvOf(face.face.map, [c[0] / 16, c[1] / 16, c[2] / 16])[0]);
      expect(Math.min(...us)).toBeCloseTo(0, 4);
      expect(Math.max(...us)).toBeCloseTo(1, 4);
    }
  });
});
