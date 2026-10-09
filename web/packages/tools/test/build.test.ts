import { describe, expect, it } from "vitest";
import { MemoryHost } from "../src/index.ts";
import { call, fingerprint, ok, setup } from "./helpers.ts";

const box = (...b: number[]) => ({ box: b });

describe("build", () => {
  const plan = {
    origin: [10, 0, 10],
    legend: {
      F: "Floor",
      W: { semantic: "Wall", facing: "east" },
      T: [{ semantic: "Trim", slot: "north-east" }],
    },
    layers: [
      ["FFF", "FFF"],
      ["W.T", "..."],
    ],
  };

  it("places text layers and reads back the same through inspect layers", async () => {
    const { host, project } = setup();
    const r = await ok(host, "build", plan);
    expect(r.changed).toBe(6 + 2);
    expect(r.cells_in_text).toBe(8);
    expect(r.bounds).toEqual([10, 0, 10, 12, 1, 11]);
    expect(project.world.get(10, 1, 10)?.semantic).toBe(2);
    const cells = await ok(host, "inspect", { view: "cells", where: box(10, 1, 10, 12, 1, 10) });
    expect(cells.cells[0]).toEqual({ at: [10, 1, 10], semantic: "Wall", facing: "east" });
    expect(cells.cells[1].parts[0]).toMatchObject({ semantic: "Trim", slot: "north-east" });

    // Round trip: layers out, then built elsewhere.
    const layers = await ok(host, "inspect", { view: "layers", where: box(10, 0, 10, 12, 1, 11) });
    const copy = MemoryHost.create({ chunkBits: 4 });
    await ok(copy, "palette_edit", {
      palette: "Main",
      ops: [
        { op: "add", semantic: "Floor" },
        { op: "add", semantic: "Wall" },
        { op: "add", semantic: "Trim", shape: "edge1" },
      ],
    });
    const back = await ok(copy, "build", {
      origin: layers.origin,
      legend: layers.legend,
      layers: layers.layers,
    });
    expect(back.changed).toBe(8);
  });

  it("elevation axes, clearing with '_', and leaving cells with '.'", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 2, 2, 0), semantic: "Wall" });
    await ok(host, "build", {
      origin: [0, 2, 0],
      axis: "z",
      legend: { G: "Glass" },
      layers: [["G_.", "..."]],
    });
    expect(project.world.get(0, 2, 0)?.semantic).toBe(3);
    expect(project.world.get(1, 2, 0)).toBeNull();
    expect(project.world.get(2, 2, 0)?.semantic).toBe(2);
    expect(project.world.get(0, 1, 0)?.semantic).toBe(2);
  });

  it("names a legend semantic that does not exist, with near matches", async () => {
    const { host, project } = setup();
    const before = fingerprint(project);
    const r = await call(host, "build", {
      origin: [0, 0, 0],
      legend: { F: "Flor" },
      layers: [["F"]],
    });
    expect(r.error.code).toBe("not_found");
    expect(r.error.suggestions[0]).toBe("Floor");
    const bad = await call(host, "build", {
      origin: [0, 0, 0],
      legend: { F: "Floor" },
      layers: [["FX"]],
    });
    expect(bad.error.code).toBe("bad_argument");
    expect(bad.error.problems[0]).toContain("'X' isn't in the legend");
    expect(fingerprint(project)).toBe(before);
  });

  it("supports dry_run, op_id and one undo", async () => {
    const { host, project } = setup();
    const before = fingerprint(project);
    const dry = await ok(host, "build", { ...plan, dry_run: true });
    expect(dry.changed).toBe(8);
    expect(fingerprint(project)).toBe(before);
    await ok(host, "build", { ...plan, op_id: "b1" });
    expect((await ok(host, "build", { ...plan, op_id: "b1" })).duplicate).toBe(true);
    await ok(host, "history", { action: "undo" });
    expect(project.world.cellCount).toBe(0);
  });
});

describe("transform", () => {
  async function house() {
    const s = setup();
    await ok(s.host, "build", {
      origin: [0, 0, 0],
      legend: { F: "Floor", W: { semantic: "Wall", facing: "east" } },
      layers: [
        ["FFF", "FFF"],
        ["W..", "..."],
      ],
    });
    return s;
  }

  it("moves by an offset and clears the source", async () => {
    const { host, project } = await house();
    const r = await ok(host, "transform", { where: box(0, 0, 0, 2, 1, 1), by: [10, 0, 0] });
    expect(r.cells_written).toBe(7);
    expect(project.world.cellCount).toBe(7);
    expect(project.world.get(0, 0, 0)).toBeNull();
    expect(project.world.get(10, 1, 0)).toMatchObject({ semantic: 2 });
  });

  it("copies to a target corner, keeping the original", async () => {
    const { host, project } = await house();
    const r = await ok(host, "transform", {
      where: box(0, 0, 0, 2, 1, 1),
      to: [0, 0, 20],
      copy: true,
    });
    expect(r.changed).toBe(7);
    expect(project.world.cellCount).toBe(14);
    expect(project.world.get(0, 1, 20)).toMatchObject({ semantic: 2 });
  });

  it("turns in place, orientation following, and mirrors", async () => {
    const { host } = await house();
    await ok(host, "transform", { where: box(0, 0, 0, 2, 1, 1), turn: 1 });
    // A quarter turn clockwise from above: the wall that faced east now faces south.
    const turned = await ok(host, "inspect", { view: "cells", where: { semantic: "Wall" } });
    expect(turned.cells[0]).toMatchObject({ semantic: "Wall", facing: "south" });
    const bounds = (await ok(host, "inspect", { view: "summary" })).bounds;
    expect(bounds[0]).toBe(0);
    expect(bounds[2]).toBe(0);

    await ok(host, "transform", { where: { semantic: "Wall" }, mirror: "x" });
    expect((await ok(host, "inspect", { view: "summary" })).cells).toBe(7);
  });

  it("validates its arguments and handles empty regions", async () => {
    const { host } = await house();
    expect((await call(host, "transform", { where: box(0, 0, 0, 1, 1, 1) })).error.code).toBe(
      "bad_argument",
    );
    expect(
      (await call(host, "transform", { where: box(0, 0, 0, 1, 1, 1), copy: true, turn: 1 })).error
        .code,
    ).toBe("bad_argument");
    expect(
      (
        await call(host, "transform", {
          where: box(0, 0, 0, 1, 1, 1),
          by: [1, 0, 0],
          to: [0, 0, 0],
        })
      ).error.code,
    ).toBe("bad_argument");
    const none = await ok(host, "transform", { where: box(50, 50, 50, 51, 51, 51), by: [1, 0, 0] });
    expect(none.problems[0]).toContain("no cells");
  });

  it("is one undo step, with dry_run changing nothing", async () => {
    const { host, project } = await house();
    const before = fingerprint(project);
    const dry = await ok(host, "transform", {
      where: box(0, 0, 0, 2, 1, 1),
      by: [5, 0, 0],
      dry_run: true,
    });
    expect(dry.dry_run).toBe(true);
    expect(fingerprint(project)).toBe(before);
    await ok(host, "transform", { where: box(0, 0, 0, 2, 1, 1), by: [5, 0, 0] });
    await ok(host, "history", { action: "undo" });
    expect(project.world.get(0, 0, 0)).not.toBeNull();
    expect(project.world.cellCount).toBe(7);
  });
});

describe("describe_shapes", () => {
  it("lists shapes and describes one, without a project", async () => {
    const host = new MemoryHost(null);
    const list = await ok(host, "describe_shapes");
    expect(list.shapes.length).toBe(12 + 16);
    expect(list.shapes.find((s: { shape: string }) => s.shape === "edge1")).toMatchObject({
      name: "Strip",
      family: "edge",
    });
    const edge = await ok(host, "describe_shapes", { shape: "edge1" });
    expect(edge.slots).toContain("south-east");
    expect(edge.slots).toHaveLength(12);
    const roof = await ok(host, "describe_shapes", {
      shape: "roof_tile",
      up: "up",
      facing: "north",
    });
    expect(roof.slots).toHaveLength(24);
    expect(roof.slot).toBe("up=up turn=0");
    expect((await call(host, "describe_shapes", { shape: "edge" })).error.suggestions).toContain(
      "edge1",
    );
    expect((await call(host, "describe_shapes", { shape: "edge1", up: "up" })).error.code).toBe(
      "bad_argument",
    );
  });
});
