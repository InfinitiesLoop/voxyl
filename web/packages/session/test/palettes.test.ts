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

describe("PaletteStore.seed", () => {
  const starters = [
    { key: "starter-a", name: "A", semantics: [{ key: "w", name: "Wall" }] },
    { key: "starter-b", name: "B", semantics: [{ key: "w", name: "Wall" }] },
  ];

  it("puts the starters in once, and a deleted one stays deleted", async () => {
    const store = new PaletteStore(new MemoryFolder());
    await store.seed(starters);
    expect((await store.list()).map((p) => p.key).sort()).toEqual(["starter-a", "starter-b"]);
    await store.delete("starter-a");
    await store.seed(starters);
    expect((await store.list()).map((p) => p.key)).toEqual(["starter-b"]);
  });

  it("leaves a palette the user already has under the same key alone", async () => {
    const store = new PaletteStore(new MemoryFolder());
    await store.save({ key: "starter-a", name: "Mine", semantics: [] });
    await store.seed(starters);
    expect((await store.load("starter-a"))?.name).toBe("Mine");
  });
});
