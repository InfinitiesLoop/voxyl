import { describe, expect, it } from "vitest";
import { call, fingerprint, ok, setup } from "./helpers.ts";

const box = (...b: number[]) => ({ box: b });
const cellsOf = async (host: Parameters<typeof ok>[0]) =>
  (await ok(host, "inspect", { view: "cells", limit: 1000 })).cells as {
    at: number[];
    semantic?: string;
    facing?: string;
    parts?: { slot: string }[];
  }[];

describe("symmetry and repeat", () => {
  it("mirror_x copies a placement across the plane", async () => {
    const { host } = setup();
    // Plane x = 5: a cell at x=2 has its image at x=8.
    const r = await ok(host, "place", {
      at: [[2, 0, 0]],
      semantic: "Wall",
      symmetry: { mirror_x: 5 },
    });
    expect(r.changed).toBe(2);
    expect(r.copies).toBe(2);
    expect((await cellsOf(host)).map((c) => c.at.join(","))).toEqual(["2,0,0", "8,0,0"]);
  });

  it("rotate4 about a boundary centre makes four corners, and facing turns with them", async () => {
    const { host } = setup();
    const r = await ok(host, "place", {
      cells: [{ at: [0, 0, 0], semantic: "Wall", facing: "north" }],
      symmetry: { rotate4: [5.5, 5.5] },
    });
    expect(r.changed).toBe(4);
    const cells = await cellsOf(host);
    expect(cells.map((c) => c.at.join(",")).sort()).toEqual([
      "0,0,0",
      "0,0,11",
      "11,0,0",
      "11,0,11",
    ]);
    // The four copies face four different ways.
    expect(new Set(cells.map((c) => c.facing)).size).toBe(4);
  });

  it("a centre that puts cells between cells is refused with advice", async () => {
    const { host, project } = setup();
    const before = fingerprint(project);
    const r = await call(host, "fill", {
      where: box(0, 0, 0, 1, 0, 1),
      semantic: "Wall",
      symmetry: { rotate4: [5.5, 5] },
    });
    expect(r.error.code).toBe("bad_argument");
    expect(r.error.message).toContain("between cells");
    expect(fingerprint(project)).toBe(before);
  });

  it("fill, clear and replace go through symmetry, one undo step", async () => {
    const { host, project } = setup();
    await ok(host, "fill", {
      where: box(0, 0, 0, 1, 1, 1),
      semantic: "Wall",
      symmetry: { mirror_x: 5, mirror_z: 5 },
      op_id: "f1",
    });
    expect(project.world.cellCount).toBe(8 * 4);
    const steps = project.history.filter((h) => h.command.group === "claude:f1").length;
    expect(steps).toBeGreaterThanOrEqual(1);
    // Replace everywhere via the mirrored regions.
    const rep = await ok(host, "replace", {
      from: "Wall",
      to: "Floor",
      where: box(0, 0, 0, 1, 1, 1),
      symmetry: { mirror_x: 5, mirror_z: 5 },
    });
    expect(rep.switched).toBe(8 * 4);
    const clr = await ok(host, "clear", {
      where: box(0, 0, 0, 1, 1, 1),
      semantic: "Floor",
      symmetry: { mirror_x: 5, mirror_z: 5 },
    });
    expect(clr.changed).toBe(32);
    expect(project.world.cellCount).toBe(0);
    // One tool call is one undo step even with 4 copies.
    await ok(host, "history", { action: "undo" });
    expect(project.world.cellCount).toBe(32);
  });

  it("a non-box region is covered exactly", async () => {
    const { host, project } = setup();
    await ok(host, "place", {
      at: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      semantic: "Wall",
    });
    // Fill the region {semantic Wall} (an L) with Floor, mirrored on x=10.
    await ok(host, "fill", {
      where: { semantic: "Wall" },
      semantic: "Floor",
      symmetry: { mirror_x: 10 },
    });
    expect(project.world.cellCount).toBe(6);
    expect(
      (await cellsOf(host))
        .filter((c) => c.semantic === "Floor")
        .map((c) => c.at.join(","))
        .sort(),
    ).toEqual(["0,0,0", "0,0,1", "1,0,0", "19,0,0", "20,0,0", "20,0,1"]);
  });

  it("parts mirror with their slots; build repeats and combines with symmetry", async () => {
    const { host } = setup();
    await ok(host, "place", {
      cells: [{ at: [0, 0, 0], semantic: "Trim", slot: "south-east" }],
      symmetry: { mirror_x: 2 },
    });
    const cells = await cellsOf(host);
    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.parts?.[0]?.slot).sort()).toEqual(["south-east", "south-west"]);

    const host2 = setup().host;
    const r = await ok(host2, "build", {
      origin: [0, 0, 0],
      legend: { W: "Wall" },
      layers: [["WW"]],
      repeat: { count: 3, step: [0, 0, 4] },
    });
    expect(r.changed).toBe(6);
    expect(r.copies).toBe(3);
  });

  it("repeat grids, dry runs, caps", async () => {
    const { host, project } = setup();
    const before = fingerprint(project);
    const dry = await ok(host, "fill", {
      where: box(0, 0, 0, 0, 0, 0),
      semantic: "Wall",
      repeat: { count: [2, 2, 2], step: [3, 3, 3] },
      dry_run: true,
    });
    expect(dry.changed).toBe(8);
    expect(fingerprint(project)).toBe(before);
    const big = await call(host, "fill", {
      where: box(0, 0, 0, 99, 99, 99),
      semantic: "Wall",
      repeat: { count: 3, step: [200, 0, 0] },
    });
    expect(big.error.code).toBe("too_large");
    const lots = await call(host, "fill", {
      where: box(0, 0, 0, 0, 0, 0),
      semantic: "Wall",
      repeat: { count: [20, 20, 20], step: [1, 1, 1] },
    });
    expect(lots.error.code).toBe("too_large");
  });
});
