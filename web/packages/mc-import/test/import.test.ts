import { compileBlock } from "@voxyl/blocks";
import { IDENTITY } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { decodePng, importJar, ZipReader } from "../src/index.ts";
import { utf8 } from "../src/streams.ts";
import { png, solid, zip } from "./helpers.ts";

const json = (value: unknown) => JSON.stringify(value);

async function testJar(): Promise<Uint8Array> {
  return zip({
    "version.json": json({ id: "9.9", name: "9.9" }),
    "assets/minecraft/blockstates/stone.json": json({ variants: { "": { model: "block/stone" } } }),
    "assets/minecraft/blockstates/log.json": json({
      variants: {
        "axis=y": { model: "minecraft:block/log" },
        "axis=x": { model: "minecraft:block/log", x: 90, y: 90 },
        "axis=z": { model: "minecraft:block/log", x: 90 },
      },
    }),
    "assets/minecraft/blockstates/grass_block.json": json({
      variants: { "snowy=false": [{ model: "block/grass_block" }, { model: "block/stone" }] },
    }),
    "assets/minecraft/blockstates/air.json": json({ variants: { "": { model: "block/air" } } }),
    "assets/minecraft/models/block/block.json": json({ textures: { particle: "#all" } }),
    "assets/minecraft/models/block/cube.json": json({
      parent: "block/block",
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: Object.fromEntries(
            ["down", "up", "north", "south", "west", "east"].map((s) => [
              s,
              { texture: `#${s}`, cullface: s },
            ]),
          ),
        },
      ],
    }),
    "assets/minecraft/models/block/cube_all.json": json({
      parent: "block/cube",
      textures: {
        down: "#all",
        up: "#all",
        north: "#all",
        south: "#all",
        west: "#all",
        east: "#all",
      },
    }),
    "assets/minecraft/models/block/cube_column.json": json({
      parent: "block/cube",
      textures: {
        down: "#end",
        up: "#end",
        north: "#side",
        south: "#side",
        west: "#side",
        east: "#side",
      },
    }),
    "assets/minecraft/models/block/stone.json": json({
      parent: "minecraft:block/cube_all",
      textures: { all: "minecraft:block/stone" },
    }),
    "assets/minecraft/models/block/log.json": json({
      parent: "block/cube_column",
      textures: { end: "block/log_top", side: "block/log" },
    }),
    "assets/minecraft/models/block/grass_block.json": json({
      textures: { top: "block/grass_top", side: "block/dirt", overlay: "block/grass_side" },
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: {
            up: { texture: "#top", tintindex: 0 },
            north: { texture: "#side" },
          },
        },
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: { texture: "#overlay", tintindex: 0 } },
        },
      ],
    }),
    "assets/minecraft/textures/block/stone.png": await png(16, 16, solid(120, 120, 120)),
    "assets/minecraft/textures/block/log.png": await png(16, 16, solid(100, 70, 40)),
    // Animated: two frames; only the first is kept.
    "assets/minecraft/textures/block/log_top.png": await png(16, 32, solid(180, 150, 90, 255, 2)),
    "assets/minecraft/textures/block/grass_top.png": await png(16, 16, solid(200, 200, 200)),
    "assets/minecraft/textures/block/dirt.png": await png(16, 16, solid(130, 90, 60)),
    "assets/minecraft/textures/block/grass_side.png": await png(16, 16, solid(255, 255, 255, 0)),
  });
}

describe("zip and png", () => {
  it("reads stored and deflated entries", async () => {
    const reader = await ZipReader.fromBytes(await zip({ a: "first", b: "second" }));
    expect(utf8.decode((await reader.read("a")) ?? new Uint8Array())).toBe("first");
    expect(utf8.decode((await reader.read("b")) ?? new Uint8Array())).toBe("second");
    expect(await reader.read("c")).toBeNull();
  });

  it("decodes an RGBA PNG", async () => {
    const pixels = solid(10, 20, 30, 40);
    pixels.set([1, 2, 3, 4], 0);
    const image = await decodePng(await png(16, 16, pixels));
    expect([image.width, image.height]).toEqual([16, 16]);
    expect(image.rgba).toEqual(pixels);
  });
});

describe("importJar", () => {
  it("resolves parents and texture references into whole cubes", async () => {
    const { library, version, skipped } = await importJar(await testJar());
    expect(version).toBe("9.9");
    expect(skipped).toEqual(["air"]);
    const libs = new Map([[library.id, library]]);
    const stone = compileBlock(libs, "minecraft:stone", IDENTITY);
    expect(stone?.cube?.every((f) => f?.texture === "minecraft:block/stone")).toBe(true);
    expect(library.blocks.stone?.color).toBe("#787878");
    // The first of several random variants.
    expect(library.blocks.grass_block?.variants?.["snowy=false"]?.model).toBe(
      "block/grass_block@#91bd59",
    );
  });

  it("keeps an animated texture's first frame, and orients columns by their axis", async () => {
    const { library } = await importJar(await testJar());
    expect(library.textures["block/log_top"]?.size).toBe(16);
    const libs = new Map([[library.id, library]]);
    const upright = compileBlock(libs, "minecraft:log", IDENTITY);
    expect(upright?.cube?.[2]?.texture).toBe("minecraft:block/log_top"); // +Y
    expect(upright?.cube?.[4]?.texture).toBe("minecraft:block/log"); // +Z
  });

  it("layers a grass block's side overlay over its dirt, tint baked in", async () => {
    const { library } = await importJar(await testJar());
    const model = library.models["block/grass_block@#91bd59"];
    expect(model?.elements).toHaveLength(1);
    const north = model?.elements[0]?.faces.north;
    expect(north?.texture).toBe("block/dirt+block/grass_side@#91bd59");
    // The overlay is fully transparent here, so the dirt shows.
    expect(library.textures[north?.texture ?? ""]?.color).toBe("#825a3c");
    expect(model?.elements[0]?.faces.up?.tint).toBe("#91bd59");
  });
});
