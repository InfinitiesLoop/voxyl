import { describe, expect, it } from "vitest";
import {
  type Command,
  CommandError,
  MAX_REGION_CELLS,
  Project,
  ROOT_PALETTE,
} from "../src/index.ts";

let n = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `g${n++}`, kind, args });

/** A hall floor (Floor), and two separate walkways (Deck and Rail) in their own palette. */
function site() {
  const p = new Project({ chunkBits: 4 });
  const floor = p.semantics.add("Floor");
  const walkway = p.semantics.addPalette("Walkway", { extends: ROOT_PALETTE });
  const deck = p.semantics.add("Deck", { palette: walkway });
  const rail = p.semantics.add("Rail", { palette: walkway, form: { shape: "edge1" } });
  p.run(cmd("fill", { where: { box: [0, 0, 0, 19, 0, 19] }, state: { semantic: floor } }));
  // Walkway A along x at z = 30, walkway B at z = 40; they don't touch.
  for (const z of [30, 40]) {
    p.run(cmd("fill", { where: { box: [0, 5, z, 9, 5, z + 1] }, state: { semantic: deck } }));
    p.run(
      cmd("fill", {
        where: { box: [0, 6, z, 9, 6, z] },
        state: { parts: [{ semantic: rail, shape: "edge1", slot: 4 }] },
      }),
    );
  }
  return { p, floor, walkway, deck, rail };
}

describe("regions", () => {
  it("select a group by palette, parts included, and exact cells by semantic", () => {
    const { p, walkway, deck } = site();
    const group = p.preview(cmd("clear", { where: { palette: walkway } }));
    expect(group.report.cells).toBe(2 * (20 + 10)); // two walkways: 20 deck + 10 rail each
    const decks = p.preview(
      cmd("clear", { where: { semantic: deck, within: { box: [0, 0, 0, 9, 9, 35] } } }),
    );
    expect(decks.report.cells).toBe(20); // walkway A's deck only
  });

  it("find a connected structure from a seed without crossing to the other walkway", () => {
    const { p, deck, rail } = site();
    const r = p.preview(
      cmd("clear", { where: { structure: { seed: [3, 5, 30], semantics: [deck, rail] } } }),
    );
    expect(r.report.cells).toBe(30);
    expect(r.report.bounds).toEqual({ x0: 0, y0: 5, z0: 30, x1: 9, y1: 6, z1: 31 });
    // A seed on an empty cell finds nothing.
    const empty = p.preview(cmd("clear", { where: { structure: { seed: [3, 9, 30] } } }));
    expect(empty.report.cells).toBe(0);
  });

  it("combine with all, any and not, and grow or shrink", () => {
    const { p, floor, walkway } = site();
    const notWalkway = p.preview(
      cmd("clear", {
        where: { all: [{ box: [0, 0, 0, 99, 99, 99] }, { not: { palette: walkway } }] },
      }),
    );
    expect(notWalkway.report.cells).toBe(400); // just the floor
    const either = p.preview(
      cmd("clear", { where: { any: [{ semantic: floor }, { palette: walkway }] } }),
    );
    expect(either.report.cells).toBe(460);
    // The floor is one layer thick, so shrinking it leaves nothing.
    const shrunk = p.preview(cmd("clear", { where: { shrink: 1, of: { semantic: floor } } }));
    expect(shrunk.report.cells).toBe(0);
    // Growing one floor cell reaches its 4 floor neighbours (already Floor) and the cells
    // above and below it (empty): 2 change.
    const grown = p.preview(
      cmd("fill", {
        where: { grow: 1, of: { box: [5, 0, 5, 5, 0, 5] } },
        state: { semantic: floor },
      }),
    );
    expect(grown.report.cells).toBe(2);
    expect(() => p.run(cmd("clear", { where: { not: { semantic: floor } } }))).toThrow(
      CommandError,
    );
  });

  it("keep the selection in the project, so commands can refer to it", () => {
    const { p, walkway, rail } = site();
    const s = p.run(cmd("select", { where: { palette: walkway } }));
    expect(s.report.notes.selected).toBe(60);
    p.run(cmd("select", { where: { all: [{ selection: true }, { semantic: rail }] } }));
    expect(p.selection?.size).toBe(20);
    expect(p.applied.at(-1)?.selection?.before?.size).toBe(60);
    expect(p.run(cmd("clear", { where: { selection: true } })).report.cells).toBe(20);
    p.run(cmd("select", { where: null }));
    expect(p.selection).toBeNull();
  });

  it("refuse regions too big to hold", () => {
    const { p } = site();
    expect(() => p.run(cmd("select", { where: { box: [0, 0, 0, 1000, 1000, 1000] } }))).toThrow(
      CommandError,
    );
    expect(MAX_REGION_CELLS).toBeGreaterThan(1_000_000);
  });
});
