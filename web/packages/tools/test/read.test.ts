import { describe, expect, it } from "vitest";
import { call, fingerprint, ok, setup } from "./helpers.ts";

const box = (...b: number[]) => ({ box: b });

describe("status", () => {
  it("describes an empty project, with conventions", async () => {
    const { host } = setup();
    const r = await ok(host, "status");
    expect(r.project).toMatchObject({ name: "Untitled", north: "north", cells: 0, bounds: null });
    expect(r.editor_attached).toBe(false);
    expect(r.selection).toBeNull();
    expect(r.history).toEqual({ next_undo: null, next_redo: null });
    expect(r.palettes).toEqual([
      {
        name: "Main",
        semantics: [
          { name: "Floor" },
          { name: "Wall" },
          { name: "Glass" },
          { name: "Trim", shape: "edge1" },
          { name: "Roof", shape: "roof_tile" },
        ],
      },
      { name: "Alt", extends: "Main", semantics: [{ name: "Lamp" }] },
    ]);
    expect(r.conventions).toContain("north is -Z");
  });

  it("reports cells, the selection and the history labels", async () => {
    const { host } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 3, 1, 3), semantic: "Wall" });
    await ok(host, "select", { where: box(0, 0, 0, 1, 0, 1) });
    const r = await ok(host, "status");
    expect(r.project.cells).toBe(32);
    expect(r.project.bounds).toEqual([0, 0, 0, 3, 1, 3]);
    expect(r.selection).toEqual({ cells: 4, bounds: [0, 0, 0, 1, 0, 1] });
    expect(r.history).toEqual({ next_undo: "Claude: fill", next_redo: null });
  });
});

describe("inspect", () => {
  async function built() {
    const s = setup();
    await ok(s.host, "fill", { where: box(0, 0, 0, 3, 0, 3), semantic: "Floor" });
    await ok(s.host, "fill", { where: box(0, 1, 0, 3, 2, 0), semantic: "Wall" });
    await ok(s.host, "place", {
      cells: [{ at: [9, 0, 0], semantic: "Trim", slot: "north-east" }],
    });
    return s;
  }

  it("summarises by semantic, and by the block each maps to", async () => {
    const { host } = await built();
    const s = await ok(host, "inspect", { view: "summary" });
    expect(s.cells).toBe(16 + 8 + 1);
    expect(s.bounds).toEqual([0, 0, 0, 9, 2, 3]);
    expect(s.blocks).toEqual([
      { semantic: "Floor", count: 16 },
      { semantic: "Wall", count: 8 },
    ]);
    expect(s.parts).toEqual([{ semantic: "Trim", shape: "edge1", count: 1 }]);
    const m = await ok(host, "inspect", { view: "materials" });
    expect(m.materials).toEqual([
      { block: "minecraft:stone", shape: null, count: 16, semantics: ["Floor"] },
      { block: "minecraft:bricks", shape: null, count: 8, semantics: ["Wall"] },
      { block: null, shape: "edge1", count: 1, semantics: ["Trim"] },
    ]);
    const some = await ok(host, "inspect", { where: { semantic: "Wall" } });
    expect(some.cells).toBe(8);
  });

  it("prints layers with a legend, and refuses a region too big to read", async () => {
    const { host } = await built();
    const r = await ok(host, "inspect", { view: "layers", where: box(0, 0, 0, 3, 1, 0) });
    expect(r.view).toBe("layers");
    expect(r.axis).toBe("y");
    expect(r.layers).toHaveLength(2);
    expect(Object.values(r.legend)).toEqual(expect.arrayContaining(["Floor", "Wall"]));
    const side = await ok(host, "inspect", {
      view: "layers",
      axis: "z",
      where: box(0, 0, 0, 3, 2, 0),
    });
    expect(side.axis).toBe("z");

    await ok(host, "place", { at: [[300, 300, 300]], semantic: "Floor" });
    const tooBig = await call(host, "inspect", { view: "layers" });
    expect(tooBig.error.code).toBe("too_large");
    expect(tooBig.error.bounds).toEqual([0, 0, 0, 300, 300, 300]);
    const empty = await ok(setup().host, "inspect", { view: "layers" });
    expect(empty.layers).toEqual([]);
  });

  it("lists cells with their full state, paged", async () => {
    const { host } = await built();
    const page = await ok(host, "inspect", { view: "cells", limit: 10 });
    expect(page.total).toBe(25);
    expect(page.returned).toBe(10);
    expect(page.next_offset).toBe(10);
    const rest = await ok(host, "inspect", { view: "cells", limit: 100, offset: 10 });
    expect(rest.returned).toBe(15);
    expect(rest.next_offset).toBeUndefined();
    const trim = await ok(host, "inspect", { view: "cells", where: box(9, 0, 0, 9, 0, 0) });
    expect(trim.cells).toEqual([
      { at: [9, 0, 0], parts: [{ semantic: "Trim", shape: "edge1", slot: "north-east" }] },
    ]);
    expect((await call(host, "inspect", { view: "cells", limit: 5000 })).error.code).toBe(
      "bad_argument",
    );
  });

  it("reads change nothing", async () => {
    const { host, project } = await built();
    const before = fingerprint(project);
    for (const view of ["summary", "materials", "cells"]) await ok(host, "inspect", { view });
    await ok(host, "status");
    expect(fingerprint(project)).toBe(before);
  });
});

describe("select", () => {
  it("selects any region, refines it, and clears it", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 3, 0, 3), semantic: "Floor" });
    await ok(host, "fill", { where: box(0, 1, 0, 3, 1, 0), semantic: "Wall" });
    const walls = await ok(host, "select", { where: { semantic: "Wall" } });
    expect(walls.selected).toBe(4);
    expect(walls.bounds).toEqual([0, 1, 0, 3, 1, 0]);
    expect(project.selection?.size).toBe(4);
    // Selecting relative to the selection.
    const narrowed = await ok(host, "select", {
      where: { all: [{ selection: true }, box(0, 0, 0, 1, 9, 9)] },
    });
    expect(narrowed.selected).toBe(2);
    const edit = await ok(host, "clear", { where: { selection: true } });
    expect(edit.changed).toBe(2);
    const cleared = await ok(host, "select", { where: null });
    expect(cleared.selected).toBe(0);
    expect(project.selection).toBeNull();
    const none = await ok(host, "select", { where: { semantic: "Glass" } });
    expect(none.problems[0]).toContain("no cells");
  });

  it("is not an undo step", async () => {
    const { host } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Wall" });
    await ok(host, "select", { where: box(0, 0, 0, 0, 0, 0) });
    expect((await ok(host, "status")).history.next_undo).toBe("Claude: fill");
  });
});
