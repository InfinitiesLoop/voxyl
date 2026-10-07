import { compose, IDENTITY, rotate, rotationFacing, turn, turnClockwise } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  buildDefaultLibrary,
  compileBlock,
  DEFAULT_TEXTURE_KEYS,
  type Element,
  faceUvMap,
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
