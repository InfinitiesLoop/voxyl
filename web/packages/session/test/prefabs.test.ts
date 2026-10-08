import { CellSet, cutPiece, Project } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { cleanTags, MemoryFolder, PrefabStore } from "../src/index.ts";

function piece() {
  const project = new Project();
  const wall = project.semantics.ensure("Wall");
  const id = project.world.states.intern({ semantic: wall });
  project.world.setId(0, 0, 0, id);
  project.world.setId(1, 0, 0, id);
  project.world.setId(1, 1, 0, id);
  const made = cutPiece(
    { world: project.world, semantics: project.semantics, north: project.settings.north },
    CellSet.ofBox({ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 0 }),
  );
  if (!made) throw new Error("no piece");
  return made;
}

describe("PrefabStore", () => {
  it("keeps a piece and gives it back whole", async () => {
    const store = new PrefabStore(new MemoryFolder());
    const entry = await store.save(piece(), { name: "  Corner  ", tags: ["Tower", "tower", " "] });
    expect(entry).toMatchObject({ name: "Corner", tags: ["tower"], cells: 3, size: [2, 2, 1] });
    expect(entry.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await store.load(entry.id)).toEqual(piece());
    expect((await store.list()).map((p) => p.id)).toEqual([entry.id]);
  });

  it("lists the newest first, and forgets a deleted prefab", async () => {
    const store = new PrefabStore(new MemoryFolder());
    const a = await store.save(piece(), { name: "A" }, 1000);
    const b = await store.save(piece(), { name: "B" }, 2000);
    expect((await store.list()).map((p) => p.name)).toEqual(["B", "A"]);
    await store.delete(b.id);
    expect((await store.list()).map((p) => p.id)).toEqual([a.id]);
    expect(await store.load(b.id)).toBeNull();
  });

  it("renames and re-tags without touching the piece or its hash", async () => {
    const store = new PrefabStore(new MemoryFolder());
    const before = await store.save(piece(), { name: "Old" });
    const after = await store.update(before.id, { name: "New", tags: ["a", "b"] });
    expect(after).toMatchObject({ name: "New", tags: ["a", "b"], hash: before.hash });
    expect(await store.load(before.id)).toEqual(piece());
    await expect(store.update(before.id, { name: " " })).rejects.toThrow("needs a name");
    await expect(store.update("nope", { name: "x" })).rejects.toThrow("gone");
  });

  it("stores a picture beside the piece", async () => {
    const store = new PrefabStore(new MemoryFolder());
    const thumb = new Uint8Array([1, 2, 3, 4]);
    const entry = await store.save(piece(), { name: "P", thumb });
    expect(await store.thumb(entry.id)).toEqual(thumb);
    const bare = await store.save(piece(), { name: "Q" });
    expect(await store.thumb(bare.id)).toBeNull();
  });

  it("refuses an empty name and unsafe ids", async () => {
    const store = new PrefabStore(new MemoryFolder());
    await expect(store.save(piece(), { name: "  " })).rejects.toThrow("needs a name");
    expect(await store.load("../x")).toBeNull();
    expect(await store.entry("a/b")).toBeNull();
  });

  it("cleans tags", () => {
    expect(cleanTags([" Roof ", "roof", "", "x".repeat(40)])).toEqual(["roof", "x".repeat(32)]);
    expect(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length).toBe(12);
  });
});
