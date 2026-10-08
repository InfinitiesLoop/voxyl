import { PLACEMENTS } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { historyState, newProject } from "./editing.ts";
import {
  FACING_UPSIDE_DOWN,
  fillCells,
  stateFacings,
  statePartDraws,
  strokeCommand,
} from "./flat-edit.ts";

type P = ReturnType<typeof newProject>;
const id = (p: P, name: string) => p.semantics.byName(name) as number;

describe("2D strokes", () => {
  it("draws a stroke as one command, keeping full cells, and erases", () => {
    const p = newProject("Test", 5);
    p.world.set(1, 0, 0, { semantic: id(p, "Roof") });
    const draw = strokeCommand(
      p,
      [0, 0, 0, 1, 0, 0, 2, 0, 0],
      id(p, "Wall"),
      [0, 1, 0],
      [1, 0, 0],
      "Paint",
    );
    if (!draw) throw new Error("no command");
    p.run(draw);
    expect(p.world.get(0, 0, 0)?.semantic).toBe(id(p, "Wall"));
    expect(p.world.get(1, 0, 0)?.semantic).toBe(id(p, "Roof"));
    expect(historyState(p).undo).toBe("Paint");
    const erase = strokeCommand(p, [0, 0, 0, 5, 0, 0], null, [0, 1, 0], [1, 0, 0], "Erase");
    if (!erase) throw new Error("no command");
    p.run(erase);
    expect(p.world.getId(0, 0, 0)).toBe(0);
    expect(strokeCommand(p, [5, 0, 0], null, [0, 1, 0], [1, 0, 0], "Erase")).toBeNull();
  });
});

describe("2D fill", () => {
  it("floods the same semantic on the layer, within the window", () => {
    const p = newProject("Test", 5);
    for (let x = 0; x < 4; x++) p.world.set(x, 2, 0, { semantic: id(p, "Wall") });
    p.world.set(4, 2, 0, { semantic: id(p, "Trim") });
    // A plan of layer y = 2: u = x, v = z.
    expect(fillCells(p, 1, 2, 0, 0, [-10, -10, 10, 10])).toHaveLength(4 * 3);
    expect(fillCells(p, 1, 2, 0, 0, [0, 0, 2, 1])).toHaveLength(2 * 3);
    // Empty space floods the empty cells of the window.
    expect(fillCells(p, 1, 2, 0, 1, [0, 0, 3, 3])).toHaveLength(6 * 3);
  });
});

describe("facings", () => {
  it("marks blocks that turn with their side, and upside-down ones", () => {
    const p = newProject("Test", 5);
    p.run({
      id: "f1",
      kind: "semantic_update",
      args: { semantic: id(p, "Roof"), form: { placement: PLACEMENTS.stairs } },
    });
    p.run({
      id: "f2",
      kind: "semantic_update",
      args: { semantic: id(p, "Base"), form: { placement: PLACEMENTS.cube } },
    });
    const stairs = p.world.states.intern({ semantic: id(p, "Roof") });
    const cube = p.world.states.intern({ semantic: id(p, "Base") });
    const facings = stateFacings(p);
    expect(facings[cube]).toBe(0);
    expect((facings[stairs] ?? 0) & 7).toBeGreaterThan(0);
    expect((facings[stairs] ?? 0) & FACING_UPSIDE_DOWN).toBe(0);
  });
});

describe("part footprints", () => {
  it("describes each state of parts by its boxes or triangles and its colour, and skips blocks", () => {
    const p = newProject("Test", 5);
    const trim = id(p, "Trim");
    const wall = id(p, "Wall");
    p.world.set(0, 0, 0, { semantic: wall });
    p.world.set(1, 0, 0, { parts: [{ semantic: trim, shape: "face2", slot: 0 }] });
    p.world.set(2, 0, 0, { parts: [{ semantic: trim, shape: "roof_tile", slot: 0 }] });
    const draws = statePartDraws(p);
    expect(draws.length).toBe(2);
    const slab = draws.find((d) => d.parts[0]?.boxes.length === 6);
    expect(slab?.parts[0]?.boxes).toEqual([0, 0, 0, 8, 2, 8]);
    expect(slab?.parts[0]?.tris).toEqual([]);
    const roof = draws.find((d) => (d.parts[0]?.tris.length ?? 0) > 0);
    expect(roof?.parts[0]?.boxes).toEqual([]);
    expect(roof?.parts[0]?.tris.length).toBeGreaterThan(0);
    // The colour is the trim semantic's look colour.
    expect(slab?.parts[0]?.color).toBeGreaterThan(0);
  });
});
