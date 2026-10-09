import { describe, expect, it } from "vitest";
import { MemoryHost } from "../src/index.ts";
import { call, ok, setup } from "./helpers.ts";

const box = (...b: number[]) => ({ box: b });
const cellsOf = async (host: Parameters<typeof ok>[0]) =>
  (await ok(host, "inspect", { view: "cells", limit: 1000 })).cells as {
    at: number[];
    semantic?: string;
  }[];

async function pillar() {
  const ctx = setup();
  await ok(ctx.host, "build", {
    origin: [0, 0, 0],
    legend: { W: "Wall", F: "Floor" },
    layers: [["WFW"], ["WFW"], ["WFW"]],
  });
  return ctx;
}

describe("prefabs", () => {
  it("saves a region, lists it, and describes it with north and anchor", async () => {
    const { host } = await pillar();
    const saved = await ok(host, "prefab_save", {
      name: "Column",
      where: box(0, 0, 0, 2, 2, 0),
      tags: ["Arch", "Column"],
      notes: "A three-high column.",
    });
    expect(saved.saved).toMatchObject({
      name: "Column",
      size: [3, 3, 1],
      cells: 9,
      tags: ["Arch", "Column"],
    });
    expect(saved.anchor).toEqual([1, 0, 0]);
    expect(saved.north).toBe("north");
    expect(saved.piece_semantics).toEqual(expect.arrayContaining(["Wall", "Floor"]));

    const list = await ok(host, "prefab_list", { query: "column" });
    expect(list.prefabs).toHaveLength(1);
    const got = await ok(host, "prefab_get", { prefab: "column" });
    expect(got.prefab).toMatchObject({
      name: "Column",
      anchor: [1, 0, 0],
      north: "north",
      notes: "A three-high column.",
    });
    expect(got.prefab.semantics.map((s: { in_project: boolean }) => s.in_project)).toEqual([
      true,
      true,
    ]);
    expect(got.prefab.missing_semantics).toEqual([]);
  });

  it("refuses a taken name without replace, and a repeat of the same call is safe", async () => {
    const { host } = await pillar();
    const args = { name: "Column", where: box(0, 0, 0, 2, 2, 0) };
    await ok(host, "prefab_save", args);
    expect((await call(host, "prefab_save", args)).error.code).toBe("exists");
    const again = await ok(host, "prefab_save", { ...args, replace: true });
    expect(again.replaced).toBe(1);
    expect((await ok(host, "prefab_list")).matched).toBe(1);
    const dry = await ok(host, "prefab_save", { ...args, name: "Other", dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect((await ok(host, "prefab_list")).matched).toBe(1);
    expect(
      (
        await call(host, "prefab_save", {
          ...args,
          name: "Empty",
          where: box(50, 50, 50, 51, 51, 51),
        })
      ).error.code,
    ).toBe("bad_argument");
    expect(
      (await call(host, "prefab_save", { ...args, name: "X", anchor: [99, 0, 0] })).error.code,
    ).toBe("bad_argument");
  });

  it("places turned, mirrored and repeated, as one undo step", async () => {
    const { host, project } = await pillar();
    await ok(host, "prefab_save", { name: "Column", where: box(0, 0, 0, 2, 2, 0) });
    const before = project.history.length;
    const r = await ok(host, "prefab_place", {
      prefab: "Column",
      at: [20, 0, 20],
      turn: 1,
      repeat: { count: 2, step: [0, 0, 6] },
    });
    expect(r.copies).toBe(2);
    expect(r.changed).toBe(18);
    expect(project.history.length - before).toBe(2);
    // Turned a quarter clockwise: the east-west row runs north-south now.
    const placed = (await cellsOf(host)).filter(
      (c) => c.at[0] === 20 && c.at[1] === 0 && (c.at[2] ?? 0) < 30,
    );
    expect(placed.map((c) => c.at[2] ?? 0).sort((a, b) => a - b)).toEqual([19, 20, 21, 25, 26, 27]);
    await ok(host, "history", { action: "undo" });
    expect(project.world.cellCount).toBe(9);
  });

  it("turns for north: a prefab from another north lands with north kept", async () => {
    const a = await pillar();
    await ok(a.host, "prefab_save", { name: "Column", where: box(0, 0, 0, 2, 0, 0) });
    // A second project whose north is east: +X points north there.
    const other = setup();
    for (const [k, v] of a.host.prefabStore) other.host.prefabStore.set(k, v);
    other.project.run({ id: "n", kind: "settings", args: { north: "east" } });
    const r = await ok(other.host, "prefab_place", { prefab: "Column", at: [10, 0, 10] });
    expect(r.turned_for_north).toBe(1);
    const xs = (await cellsOf(other.host)).map((c) => c.at.join(","));
    expect(xs).toEqual(["10,0,9", "10,0,10", "10,0,11"].map((s) => s));
  });

  it("reports and remaps semantics the project lacks", async () => {
    const { host } = await pillar();
    await ok(host, "prefab_save", { name: "Column", where: box(0, 0, 0, 2, 2, 0) });
    // Another project that has no Wall or Floor.
    const fresh = MemoryHost.create({ chunkBits: 4 });
    for (const [k, v] of host.prefabStore) fresh.prefabStore.set(k, v);
    const got = await ok(fresh, "prefab_get", { prefab: "Column" });
    expect(got.prefab.missing_semantics).toEqual(expect.arrayContaining(["Wall", "Floor"]));
    await ok(fresh, "palette_edit", {
      palette: "Main",
      ops: [{ op: "add", semantic: "Stone", block: "minecraft:stone" }],
    });
    const r = await ok(fresh, "prefab_place", {
      prefab: "Column",
      at: [0, 0, 0],
      remap: { Wall: "Stone" },
    });
    expect(r.missing_semantics).toEqual(["Floor"]);
    const names = new Set((await cellsOf(fresh)).map((c) => c.semantic));
    expect(names).toEqual(new Set(["Stone", "Floor"]));
    expect(
      (
        await call(fresh, "prefab_place", {
          prefab: "Column",
          at: [0, 0, 0],
          remap: { Nope: "Stone" },
        })
      ).error.code,
    ).toBe("bad_argument");
    const dry = await ok(fresh, "prefab_place", {
      prefab: "Column",
      at: [30, 0, 0],
      dry_run: true,
    });
    expect(dry.dry_run).toBe(true);
  });

  it("edits details and deletes only with confirm", async () => {
    const { host } = await pillar();
    await ok(host, "prefab_save", { name: "Column", where: box(0, 0, 0, 2, 2, 0) });
    expect(
      (await ok(host, "prefab_edit", { prefab: "Column", action: "rename", name: "Pillar" })).prefab
        .name,
    ).toBe("Pillar");
    expect(
      (await ok(host, "prefab_edit", { prefab: "Pillar", action: "tags", tags: ["a"] })).prefab
        .tags,
    ).toEqual(["a"]);
    expect(
      (await ok(host, "prefab_edit", { prefab: "Pillar", action: "notes", notes: "n" })).prefab
        .notes,
    ).toBe("n");
    const anchored = await ok(host, "prefab_edit", {
      prefab: "Pillar",
      action: "anchor",
      anchor: [0, 0, 0],
    });
    expect(anchored.prefab.name).toBe("Pillar");
    expect((await ok(host, "prefab_get", { prefab: "Pillar" })).prefab.anchor).toEqual([0, 0, 0]);
    expect(
      (await call(host, "prefab_edit", { prefab: "Pillar", action: "rename" })).error.code,
    ).toBe("bad_argument");
    expect(
      (await call(host, "prefab_edit", { prefab: "Pillar", action: "delete" })).error.code,
    ).toBe("confirm_required");
    await ok(host, "prefab_edit", { prefab: "Pillar", action: "delete", confirm: true });
    const missing = await call(host, "prefab_get", { prefab: "Pilar" });
    expect(missing.error.code).toBe("not_found");
  });
});
