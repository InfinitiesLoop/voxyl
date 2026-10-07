import { CellSet } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { boxLines, outlineOf } from "./outline.ts";

function segments(lines: Float32Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < lines.length; i += 6) {
    const a = `${lines[i]},${lines[i + 1]},${lines[i + 2]}`;
    const b = `${lines[i + 3]},${lines[i + 4]},${lines[i + 5]}`;
    out.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return out;
}

describe("outline", () => {
  it("draws a plain box as its twelve edges", () => {
    const cells = CellSet.ofBox({ x0: 2, y0: 0, z0: -1, x1: 4, y1: 0, z1: -1 });
    const outline = outlineOf(cells);
    expect(outline.box).toBe(true);
    expect(outline.exact).toBe(true);
    expect(segments(outline.lines)).toEqual(
      segments(boxLines({ x0: 2, y0: 0, z0: -1, x1: 4, y1: 0, z1: -1 })),
    );
    expect(outline.lines.length).toBe(12 * 6);
  });

  it("merges a straight run and keeps an L's inner corner", () => {
    const cells = new CellSet();
    cells.add(0, 0, 0);
    cells.add(1, 0, 0);
    cells.add(2, 0, 0);
    cells.add(2, 0, 1);
    const outline = outlineOf(cells);
    expect(outline.box).toBe(false);
    expect(outline.exact).toBe(true);
    const found = segments(outline.lines);
    // The three cells in a row share one edge.
    expect(found.has("0,0,0|3,0,0")).toBe(true);
    // The notch where the stub meets the row: a corner a solid box would not draw.
    expect(found.has("2,0,1|2,1,1")).toBe(true);
  });
});
