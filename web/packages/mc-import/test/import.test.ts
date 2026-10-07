import { compileBlock } from "@voxyl/blocks";
import { IDENTITY } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { decodePng, importJar, ZipReader } from "../src/index.ts";
import { deflate, utf8 } from "../src/streams.ts";

/** A zip of these files: even-numbered ones stored, odd ones deflated. */
async function zip(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? utf8.encode(content) : content;
    const method = i++ % 2 === 0 ? 0 : 8;
    const data = method === 8 ? await deflate(raw, "deflate-raw") : raw;
    const nameBytes = utf8.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An 8-bit RGBA PNG (filter 0 on every row; CRCs left zero, which the decoder ignores). */
async function png(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const idat = await deflate(rows, "deflate");
  const chunk = (kind: string, body: Uint8Array) => {
    const c = new Uint8Array(12 + body.length);
    new DataView(c.buffer).setUint32(0, body.length);
    c.set(utf8.encode(kind), 4);
    c.set(body, 8);
    return c;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 16-wide texture of one colour, `frames` frames tall. */
function solid(r: number, g: number, b: number, a = 255, frames = 1): Uint8Array {
  const out = new Uint8Array(16 * 16 * frames * 4);
  for (let i = 0; i < out.length; i += 4) out.set([r, g, b, a], i);
  return out;
}

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
    const reader = new ZipReader(await zip({ a: "first", b: "second" }));
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
