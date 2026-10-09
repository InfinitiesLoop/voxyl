import { describe, expect, it } from "vitest";
import { call, fingerprint, ok, setup } from "./helpers.ts";

const box = (...b: number[]) => ({ box: b });

describe("place", () => {
  it("places cells with their own semantic and orientation", async () => {
    const { host, project } = setup();
    const r = await ok(host, "place", {
      cells: [
        { at: [0, 0, 0], semantic: "Floor" },
        { at: [1, 0, 0], semantic: "Wall", facing: "east" },
        { at: [2, 0, 0], semantic: "Wall", facing: "north", up: "east" },
      ],
    });
    expect(r.changed).toBe(3);
    expect(r.placed).toBe(3);
    expect(r.rejected_count).toBe(0);
    expect(r.bounds).toEqual([0, 0, 0, 2, 0, 0]);
    expect(r.problems).toEqual([]);
    const cells = await ok(host, "inspect", { view: "cells" });
    expect(cells.cells).toEqual([
      { at: [0, 0, 0], semantic: "Floor" },
      { at: [1, 0, 0], semantic: "Wall", facing: "east" },
      { at: [2, 0, 0], semantic: "Wall", facing: "north", up: "east" },
    ]);
    expect(project.history.at(-1)?.command).toMatchObject({
      source: "Claude",
      label: "Claude: place",
    });
  });

  it("places many positions of one semantic", async () => {
    const { host } = setup();
    const r = await ok(host, "place", {
      at: [
        [0, 0, 0],
        [0, 1, 0],
        [0, 2, 0],
      ],
      semantic: "Wall",
    });
    expect(r.changed).toBe(3);
    expect(r.semantics).toEqual([{ semantic: "Wall", before: 0, after: 3 }]);
  });

  it("needs cells or at, and a semantic with at", async () => {
    const { host } = setup();
    expect((await call(host, "place", {})).error.code).toBe("bad_argument");
    expect((await call(host, "place", { at: [[0, 0, 0]] })).error.code).toBe("bad_argument");
    expect(
      (
        await call(host, "place", {
          at: [[0, 0, 0]],
          cells: [{ at: [0, 0, 0], semantic: "Wall" }],
        })
      ).error.code,
    ).toBe("bad_argument");
    expect(
      (
        await call(host, "place", {
          cells: [{ at: [0, 0, 0], semantic: "Wall", facing: "up", up: "down" }],
        })
      ).error.code,
    ).toBe("bad_argument");
  });

  it("places a shaped semantic as a part, and parts join in one cell", async () => {
    const { host } = setup();
    const r = await ok(host, "place", {
      cells: [
        { at: [0, 0, 0], semantic: "Trim", slot: "south-east" },
        { at: [0, 0, 0], semantic: "Trim", slot: "north-west" },
      ],
    });
    expect(r.rejected_count).toBe(0);
    const cell = (await ok(host, "inspect", { view: "cells" })).cells[0];
    expect(cell.parts).toHaveLength(2);
    expect(cell.parts[0]).toMatchObject({ semantic: "Trim", shape: "edge1" });
    // A second call adds to the cell it finds; the same part again is not a conflict.
    const again = await ok(host, "place", {
      cells: [
        { at: [0, 0, 0], semantic: "Trim", slot: "south-east" },
        { at: [0, 0, 0], semantic: "Trim", slot: "north-east" },
      ],
    });
    expect(again.rejected_count).toBe(0);
    const parts = (await ok(host, "inspect", { view: "cells" })).cells[0].parts;
    expect(parts).toHaveLength(3);
  });

  it("places an architecture shape through its semantic and a slot name", async () => {
    const { host } = setup();
    const r = await ok(host, "place", {
      cells: [{ at: [0, 0, 0], semantic: "Roof", slot: "up=north turn=1" }],
    });
    expect(r.changed).toBe(1);
    const cell = (await ok(host, "inspect", { view: "cells" })).cells[0];
    expect(cell.parts[0]).toMatchObject({
      semantic: "Roof",
      shape: "roof_tile",
      slot: "up=north turn=1",
    });
  });

  it("rejects what cannot exist and says why, capped", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 9, 2, 0), semantic: "Wall" });
    const r = await ok(host, "place", {
      at: Array.from({ length: 30 }, (_, i) => [i % 10, Math.floor(i / 10), 0]),
      semantic: "Trim",
      slot: "north-east",
    });
    expect(r.placed).toBe(0);
    expect(r.changed).toBe(0);
    expect(r.rejected_count).toBe(30);
    expect(r.rejected).toHaveLength(20);
    expect(r.rejected[0]).toMatchObject({ at: [0, 0, 0], reason: "block_in_cell" });
    expect(project.world.cellCount).toBe(30);

    const noSlot = await ok(host, "place", { cells: [{ at: [20, 0, 0], semantic: "Trim" }] });
    expect(noSlot.rejected[0].reason).toBe("slot_required");
    expect(noSlot.rejected[0].detail).toContain('"');
    const badSlot = await ok(host, "place", {
      cells: [{ at: [20, 0, 0], semantic: "Trim", slot: "sideways" }],
    });
    expect(badSlot.rejected[0].reason).toBe("bad_slot");
    const far = await ok(host, "place", { cells: [{ at: [10 ** 9, 0, 0], semantic: "Wall" }] });
    expect(far.rejected[0].reason).toBe("out_of_world");

    // A roof tile needs its cell to itself.
    await ok(host, "place", {
      cells: [{ at: [5, 5, 5], semantic: "Roof", slot: "up=north turn=0" }],
    });
    const clash = await ok(host, "place", {
      cells: [{ at: [5, 5, 5], semantic: "Roof", slot: "up=north turn=1" }],
    });
    expect(clash.rejected[0].reason).toBe("exclusive");
  });

  it("says so when facing or slot do not apply", async () => {
    const { host } = setup();
    const r = await ok(host, "place", {
      cells: [{ at: [0, 0, 0], semantic: "Wall", slot: "north" }],
    });
    expect(r.changed).toBe(1);
    expect(r.problems[0]).toContain("slot ignored");
  });
});

describe("fill", () => {
  it("fills solid, and a shaped semantic fills with its part", async () => {
    const { host, project } = setup();
    const r = await ok(host, "fill", { where: box(0, 0, 0, 3, 2, 3), semantic: "Wall" });
    expect(r.changed).toBe(48);
    expect(r.bounds).toEqual([0, 0, 0, 3, 2, 3]);
    expect(r.style).toBe("solid");
    const strips = await ok(host, "fill", {
      where: box(10, 0, 0, 11, 0, 0),
      semantic: "Trim",
      slot: "down-north",
    });
    expect(strips.changed).toBe(2);
    expect(project.world.cellCount).toBe(50);
    const noSlot = await call(host, "fill", { where: box(10, 0, 0, 11, 0, 0), semantic: "Trim" });
    expect(noSlot.error.code).toBe("bad_argument");
  });

  it("styles: hollow, walls, frame, floor", async () => {
    const count = async (style: string) => {
      const { host, project } = setup();
      await ok(host, "fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Wall", style });
      return project.world.cellCount;
    };
    expect(await count("hollow")).toBe(125 - 27);
    expect(await count("walls")).toBe(125 - 3 * 5 * 3);
    expect(await count("floor")).toBe(25);
    expect(await count("frame")).toBe(12 * 5 - 8 * 2);
  });

  it("hollow clears the inside unless keep_inside, and a thin box is all shell", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Glass" });
    const r = await ok(host, "fill", {
      where: box(0, 0, 0, 4, 4, 4),
      semantic: "Wall",
      style: "hollow",
    });
    expect(project.world.cellCount).toBe(98);
    expect(r.changed).toBe(125);
    expect(r.semantics).toEqual(
      expect.arrayContaining([
        { semantic: "Glass", before: 125, after: 0 },
        { semantic: "Wall", before: 0, after: 98 },
      ]),
    );

    const kept = setup();
    await ok(kept.host, "fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Glass" });
    await ok(kept.host, "fill", {
      where: box(0, 0, 0, 4, 4, 4),
      semantic: "Wall",
      style: "hollow",
      keep_inside: true,
    });
    expect(kept.project.world.cellCount).toBe(125);

    const thin = setup();
    await ok(thin.host, "fill", {
      where: box(0, 0, 0, 4, 0, 4),
      semantic: "Wall",
      style: "hollow",
    });
    expect(thin.project.world.cellCount).toBe(25);
    await ok(thin.host, "fill", {
      where: box(10, 0, 0, 11, 3, 0),
      semantic: "Wall",
      style: "walls",
    });
    expect(thin.project.world.cellCount).toBe(25 + 8);
  });

  it("styles work on any region, from its bounding box", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Floor" });
    const r = await ok(host, "fill", {
      where: { semantic: "Floor" },
      semantic: "Wall",
      style: "floor",
    });
    expect(r.changed).toBe(25);
    expect(project.world.cellCount).toBe(125);
    const empty = await ok(host, "fill", {
      where: { semantic: "Glass" },
      semantic: "Wall",
      style: "frame",
    });
    expect(empty.changed).toBe(0);
    expect(empty.problems[0]).toContain("no cells");
  });
});

describe("clear", () => {
  it("empties a region", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 3, 3, 3), semantic: "Wall" });
    const r = await ok(host, "clear", { where: box(0, 0, 0, 3, 0, 3) });
    expect(r.changed).toBe(16);
    expect(project.world.cellCount).toBe(48);
  });

  it("clears only one semantic, and only its parts in a cell of parts", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Wall" });
    await ok(host, "place", {
      cells: [
        { at: [5, 0, 0], semantic: "Trim", slot: "north-east" },
        {
          at: [5, 0, 0],
          semantic: { name: "Lamp", palette: "Alt" },
          shape: "edge1",
          slot: "south-west",
        },
      ],
    });
    const r = await ok(host, "clear", { where: box(-5, -5, -5, 9, 9, 9), semantic: "Trim" });
    expect(r.changed).toBe(1);
    expect(project.world.cellCount).toBe(3);
    const at = await ok(host, "inspect", { view: "cells", where: box(5, 0, 0, 5, 0, 0) });
    expect(at.cells[0].parts).toEqual([expect.objectContaining({ semantic: "Lamp" })]);
    const walls = await ok(host, "clear", { where: box(-5, -5, -5, 9, 9, 9), semantic: "Wall" });
    expect(walls.changed).toBe(2);
    expect(project.world.cellCount).toBe(1);
  });

  it("a semantic nothing uses yet clears nothing", async () => {
    const { host } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Wall" });
    const r = await ok(host, "clear", { where: box(0, 0, 0, 1, 0, 0), semantic: "Glass" });
    expect(r.changed).toBe(0);
    expect(r.problems[0]).toContain("No cells hold Glass");
  });
});

describe("replace", () => {
  it("turns one semantic into another, keeping orientation", async () => {
    const { host, project } = setup();
    await ok(host, "place", {
      cells: [
        { at: [0, 0, 0], semantic: "Wall", facing: "east" },
        { at: [1, 0, 0], semantic: "Wall", facing: "south" },
        { at: [2, 0, 0], semantic: "Floor" },
      ],
    });
    const r = await ok(host, "replace", { from: "Wall", to: "Glass" });
    expect(r.switched).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.changed).toBe(2);
    const cells = (await ok(host, "inspect", { view: "cells" })).cells;
    expect(cells).toEqual([
      { at: [0, 0, 0], semantic: "Glass", facing: "east" },
      { at: [1, 0, 0], semantic: "Glass", facing: "south" },
      { at: [2, 0, 0], semantic: "Floor" },
    ]);
    expect(project.world.cellCount).toBe(3);
  });

  it("limits to where, skips cells that don't fit a shape, and force relabels", async () => {
    const { host } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 3, 0, 0), semantic: "Wall" });
    const some = await ok(host, "replace", {
      from: "Wall",
      to: "Glass",
      where: box(0, 0, 0, 1, 0, 0),
    });
    expect(some.switched).toBe(2);
    const skipped = await ok(host, "replace", { from: "Wall", to: "Trim" });
    expect(skipped.switched).toBe(0);
    expect(skipped.skipped).toBe(2);
    expect(skipped.problems[0]).toContain("force");
    const forced = await ok(host, "replace", { from: "Wall", to: "Trim", force: true });
    expect(forced.switched).toBe(2);
  });

  it("names the missing semantic, and a never-used source is a no-op", async () => {
    const { host } = setup();
    expect((await call(host, "replace", { from: "Wal", to: "Glass" })).error.code).toBe(
      "not_found",
    );
    expect((await call(host, "replace", { from: "Wall", to: "Glas" })).error.code).toBe(
      "not_found",
    );
    const none = await ok(host, "replace", { from: "Wall", to: "Glass" });
    expect(none.changed).toBe(0);
    expect(none.problems[0]).toContain("No cells hold Wall");
  });
});

describe("dry_run", () => {
  it("changes nothing and reports what would change", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Wall" });
    const before = fingerprint(project);
    const calls: [string, object][] = [
      ["place", { at: [[9, 9, 9]], semantic: "Floor" }],
      ["fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Glass", style: "hollow" }],
      ["clear", { where: box(0, 0, 0, 4, 4, 4), semantic: "Wall" }],
      ["replace", { from: "Wall", to: "Glass" }],
      ["select", { where: box(0, 0, 0, 1, 1, 1) }],
      ["history", { action: "undo" }],
    ];
    for (const [name, args] of calls) {
      const dry = await ok(host, name, { ...args, dry_run: true });
      expect(dry.dry_run, name).toBe(true);
      expect(fingerprint(project), name).toBe(before);
      expect(project.selection, name).toBeNull();
    }
    expect(host.changes).toHaveLength(1);
    // The same call for real reports the same figures.
    const args = { where: box(0, 0, 0, 4, 4, 4), semantic: "Glass", style: "hollow" };
    const dry = await ok(host, "fill", { ...args, dry_run: true });
    const real = await ok(host, "fill", args);
    expect(real.dry_run).toBeUndefined();
    expect(real.changed).toBe(dry.changed);
    expect(real.bounds).toEqual(dry.bounds);
    expect(real.semantics).toEqual(dry.semantics);
  });
});

describe("op_id", () => {
  it("makes a repeated call a no-op", async () => {
    const { host, project } = setup();
    const args = {
      where: box(0, 0, 0, 2, 2, 2),
      semantic: "Wall",
      style: "hollow",
      op_id: "build-1",
    };
    const first = await ok(host, "fill", args);
    expect(first.duplicate).toBeUndefined();
    const after = fingerprint(project);
    const second = await ok(host, "fill", args);
    expect(second.duplicate).toBe(true);
    expect(fingerprint(project)).toBe(after);
    expect(host.changes).toHaveLength(1);
    // Another call with its own id still works.
    await ok(host, "clear", { where: box(0, 0, 0, 0, 0, 0), op_id: "clear-1" });
    expect(project.world.cellCount).toBe(26 - 1);
  });
});
