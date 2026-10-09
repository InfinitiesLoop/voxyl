import { PLACEMENTS } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  blockIcon,
  blockLabel,
  buildDefaultLibrary,
  profileOfBlock,
  resampleSquare,
  searchBlocks,
} from "../src/index.ts";
import type { Block } from "../src/library.ts";

const library = buildDefaultLibrary();
const libraries = new Map([[library.id, library]]);

const block = (name: string): Block => {
  const found = library.blocks[name];
  if (!found) throw new Error(`no ${name}`);
  return found;
};

describe("profiles from blocks", () => {
  it("reads stairs, slabs, logs and cubes from the default set", () => {
    expect(profileOfBlock(block("oak_stairs"))).toBe(PLACEMENTS.stairs);
    expect(profileOfBlock(block("oak_slab"))).toBe(PLACEMENTS.slab);
    expect(profileOfBlock(block("oak_log"))).toBe(PLACEMENTS.log);
    expect(profileOfBlock(block("stone"))).toBe(PLACEMENTS.cube);
    expect(profileOfBlock(block("oak_fence"))).toBe(PLACEMENTS.cube);
    expect(profileOfBlock(block("glass_pane"))).toBe(PLACEMENTS.cube);
  });

  it("tells hoppers, buttons and doors apart from their properties", () => {
    const variant = { model: "m" };
    const of = (keys: string[]) =>
      profileOfBlock({
        color: "#888888",
        variants: Object.fromEntries(keys.map((key) => [key, variant])),
      });
    expect(of(["facing=down", "facing=north", "facing=east"])).toBe(PLACEMENTS.hopper);
    expect(of(["facing=up", "facing=down", "facing=north"])).toBe(PLACEMENTS.facing);
    expect(of(["facing=north,half=lower", "facing=south,half=upper"])).toBe(PLACEMENTS.horizontal);
    expect(of(["face=floor", "face=wall", "face=ceiling"])).toMatchObject({
      pick: "attach",
      symmetry: "spin",
      up: ["up", "north", "east", "south", "west", "down"],
    });
  });
});

describe("block search", () => {
  it("names blocks in sentence case and ranks words ahead of substrings", () => {
    expect(blockLabel("voxyl:oak_stairs")).toBe("Oak stairs");
    const { hits, matched } = searchBlocks(libraries, { query: "oak stair" });
    expect(matched).toBeGreaterThan(0);
    expect(hits[0]?.ref).toBe("voxyl:oak_stairs");
    expect(hits.every((h) => h.ref.includes("oak") || h.name.toLowerCase().includes("oak"))).toBe(
      true,
    );
  });

  it("searches only the chosen libraries, and all of them when none are chosen", () => {
    const other = { ...library, id: "other", blocks: { zzz_block: library.blocks.stone as Block } };
    const both = new Map([
      [library.id, library],
      [other.id, other],
    ]);
    const all = searchBlocks(both, { query: "", limit: 1000 }).matched;
    expect(searchBlocks(both, { query: "", libraries: [] }).matched).toBe(Math.min(all, 60));
    const only = searchBlocks(both, { query: "", libraries: ["other"] });
    expect(only.hits.map((h) => h.ref)).toEqual(["other:zzz_block"]);
    const mixed = searchBlocks(both, { query: "zzz", libraries: ["other", library.id] });
    expect(mixed.hits.some((h) => h.ref === "other:zzz_block")).toBe(true);
  });

  it("lists the default set, and icons show a cube's top or a pane's glass", () => {
    const { hits, matched } = searchBlocks(libraries, { query: "" });
    // Every block but the hidden undecided placeholder.
    const offered = Object.values(library.blocks).filter((b) => !b.hidden);
    expect(matched).toBe(offered.length);
    expect(hits.some((h) => h.ref === "voxyl:undecided")).toBe(false);
    expect(hits.length).toBe(matched);
    expect(blockIcon(library, block("oak_planks"))).toEqual(library.textures.oak_planks?.rgba);
    expect(blockIcon(library, block("oak_log"))).toEqual(library.textures.oak_log_top?.rgba);
    expect(blockIcon(library, block("glass_pane"))).toEqual(library.textures.glass?.rgba);
  });

  it("returns a later page without dropping the rest of the count", () => {
    const all = searchBlocks(libraries, { query: "", limit: 1000 });
    const page = searchBlocks(libraries, { query: "", limit: 2, offset: 1 });
    expect(page.matched).toBe(all.matched);
    expect(page.hits.map((h) => h.ref)).toEqual(all.hits.slice(1, 3).map((h) => h.ref));
    expect(searchBlocks(libraries, { query: "", offset: all.matched }).hits).toEqual([]);
  });

  it("tints an icon by its face", () => {
    const tinted = {
      ...library,
      models: {
        grass: {
          elements: [
            {
              from: [0, 0, 0] as [number, number, number],
              to: [16, 16, 16] as [number, number, number],
              faces: { up: { texture: "oak_planks", tint: "#00ff00" } },
            },
          ],
        },
      },
      blocks: { grass: { variants: { "": { model: "grass" } }, color: "#00ff00" } },
    };
    const icon = blockIcon(tinted, tinted.blocks.grass as Block);
    const raw = library.textures.oak_planks?.rgba;
    if (!icon || !raw) throw new Error("no icon");
    expect(icon[0]).toBe(0);
    expect(icon[1]).toBe(raw[1]);
    expect(icon[2]).toBe(0);
  });
});

describe("textures that are not 16 pixels", () => {
  // A 32 px texture: left half red, right half blue (what a high-resolution mod ships).
  const hd = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      hd.set(x < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 32 + x) * 4);

  it("scales down to the 16 px size by averaging, and up by repeating", () => {
    const down = resampleSquare(hd, 32, 16);
    expect(down.length).toBe(16 * 16 * 4);
    expect([...down.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...down.subarray(15 * 4, 15 * 4 + 4)]).toEqual([0, 0, 255, 255]);
    const up = resampleSquare(down, 16, 32);
    expect(up).toEqual(hd);
    // Averaged colour is weighted by alpha: a clear pixel next to a solid one adds no black.
    const edge = new Uint8Array([200, 100, 50, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...resampleSquare(edge, 2, 1)]).toEqual([200, 100, 50, 64]);
  });

  it("still gives the list an icon for a high-resolution block", () => {
    const hdLibrary = {
      ...library,
      textures: { hd: { size: 32, alpha: "opaque" as const, color: "#808080", rgba: hd } },
      models: {
        hd: {
          elements: [
            {
              from: [0, 0, 0] as [number, number, number],
              to: [16, 16, 16] as [number, number, number],
              faces: { up: { texture: "hd" } },
            },
          ],
        },
      },
      blocks: { hd: { variants: { "": { model: "hd" } }, color: "#808080" } },
    };
    const icon = blockIcon(hdLibrary, hdLibrary.blocks.hd as Block);
    expect(icon?.length).toBe(1024);
    expect([...(icon?.subarray(0, 4) ?? [])]).toEqual([255, 0, 0, 255]);
  });
});
