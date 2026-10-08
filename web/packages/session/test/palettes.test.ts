import { describe, expect, it } from "vitest";
import { MemoryFolder, PaletteStore } from "../src/index.ts";

const palette = {
  key: "warm",
  name: "Warm stone",
  semantics: [{ key: "wall", name: "Wall", look: { block: "voxyl:bricks" } }],
};

describe("PaletteStore", () => {
  it("stores a palette and lists it", async () => {
    const store = new PaletteStore(new MemoryFolder());
    const saved = await store.save(palette);
    expect(saved.version).toBe(1);
    expect((await store.list()).map((p) => p.name)).toEqual(["Warm stone"]);
    expect(await store.load("warm")).toEqual(saved);
  });

  it("bumps the version only when the content changes", async () => {
    const store = new PaletteStore(new MemoryFolder());
    await store.save(palette);
    expect((await store.save(palette)).version).toBe(1);
    const changed = await store.save({ ...palette, name: "Warmer stone" });
    expect(changed.version).toBe(2);
  });

  it("deletes, and refuses unsafe keys", async () => {
    const store = new PaletteStore(new MemoryFolder());
    await store.save(palette);
    await store.delete("warm");
    expect(await store.list()).toEqual([]);
    await expect(store.save({ ...palette, key: "../x" })).rejects.toThrow();
  });
});
