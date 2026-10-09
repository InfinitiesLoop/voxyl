import { buildDefaultLibrary } from "@voxyl/blocks";
import { describe, expect, it } from "vitest";
import { MemoryHost } from "../src/index.ts";
import { call, ok } from "./helpers.ts";

const library = buildDefaultLibrary();
const libraries = new Map([[library.id, library]]);
const hostWithBlocks = () => MemoryHost.create({ chunkBits: 4, libraries });

describe("find_blocks", () => {
  it("lists the libraries", async () => {
    const r = await ok(hostWithBlocks(), "find_blocks", { libraries: true });
    expect(r.libraries).toEqual([
      { id: library.id, name: library.name, blocks: expect.any(Number) },
    ]);
    expect(r.libraries[0].blocks).toBeGreaterThan(20);
  });

  it("searches by words, pages, and limits to a library", async () => {
    const host = hostWithBlocks();
    const r = await ok(host, "find_blocks", { query: "oak", limit: 3 });
    expect(r.matched).toBeGreaterThan(3);
    expect(r.blocks).toHaveLength(3);
    expect(r.blocks[0]).toMatchObject({
      block: expect.stringContaining(":"),
      color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
    });
    expect(r.blocks.every((b: { block: string }) => b.block.includes("oak"))).toBe(true);
    expect(r.next_offset).toBe(3);
    const next = await ok(host, "find_blocks", { query: "oak", limit: 3, offset: 3 });
    expect(next.blocks[0].block).not.toBe(r.blocks[0].block);
    const stone = await ok(host, "find_blocks", { query: "stone", library: library.id });
    expect(stone.blocks.length).toBeGreaterThan(0);
    expect((await call(host, "find_blocks", { library: "nope" })).error.code).toBe("not_found");
  });

  it("ranks by colour within a tolerance", async () => {
    const host = hostWithBlocks();
    const stone = Object.entries(library.blocks).find(([id]) => id === "stone");
    const color = stone?.[1].color ?? "#808080";
    const r = await ok(host, "find_blocks", { near_color: color, tolerance: 30, limit: 5 });
    expect(r.blocks[0].distance).toBeLessThanOrEqual(r.blocks.at(-1).distance);
    expect(r.blocks[0].block).toBe(`${library.id}:stone`);
    expect(r.blocks[0].distance).toBe(0);
    expect(r.blocks.every((b: { distance: number }) => b.distance <= 30)).toBe(true);
    expect((await call(host, "find_blocks", { near_color: "red" })).error.code).toBe(
      "bad_argument",
    );
  });

  it("says when the host has no libraries, and works with no project", async () => {
    const none = new MemoryHost(null);
    const empty = await ok(none, "find_blocks", { query: "oak" });
    expect(empty.matched).toBe(0);
    expect(empty.problems[0]).toContain("No block libraries");
    const bare = { project: null };
    const r = await call(bare as never, "find_blocks", {});
    expect(r.error.code).toBe("unavailable");
  });
});

describe("palette_edit block check", () => {
  it("warns about a block the libraries lack, and still sets it", async () => {
    const host = hostWithBlocks();
    const r = await ok(host, "palette_edit", {
      palette: "Main",
      ops: [
        { op: "add", semantic: "Good", block: `${library.id}:stone` },
        { op: "add", semantic: "Odd", block: "voxyl:not_a_block" },
      ],
    });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("Odd");
    expect(r.palette.semantics[1].block).toBe("voxyl:not_a_block");
    const quiet = await ok(new MemoryHost(null), "describe_shapes");
    expect(quiet.shapes.length).toBeGreaterThan(0);
  });
});
