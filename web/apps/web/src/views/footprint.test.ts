import { describe, expect, it } from "vitest";
import type { PartDraw } from "../world/protocol.ts";
import { footprint } from "./footprint.ts";
import { orientationFor } from "./plane.ts";

const plan = orientationFor(1, "north");
const box = (b: number[], color = 0xff0000): PartDraw => ({ color, boxes: b, tris: [] });

describe("footprints of parts on a slice", () => {
  it("draws a slab against the bottom as the whole cell from above", () => {
    const [shape] = footprint([box([0, 0, 0, 8, 4, 8])], 1, plan);
    expect(shape?.points).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  });

  it("draws a strip in one corner as a small square there", () => {
    // An edge strip along Y in the +X +Z corner: 1/8 by 1/8, from above.
    const [shape] = footprint([box([7, 0, 7, 8, 8, 8])], 1, plan);
    // North up the screen is -Z, so +Z is down; east is right: the lower right corner.
    expect(shape?.points[0]).toEqual([7 / 8, 7 / 8]);
    expect(shape?.points[2]).toEqual([1, 1]);
  });

  it("follows the way the picture is turned", () => {
    const south = orientationFor(1, "south");
    const [shape] = footprint([box([7, 0, 7, 8, 8, 8])], 1, south);
    // Turned half way round, the same corner is at the upper left.
    expect(shape?.points[0]).toEqual([0, 0]);
    expect(shape?.points[2]).toEqual([1 / 8, 1 / 8]);
  });

  it("draws the nearer parts last", () => {
    const low = box([0, 0, 0, 8, 2, 8], 0x00ff00);
    const high = box([0, 6, 0, 8, 8, 8], 0x0000ff);
    const order = footprint([high, low], 1, plan).map((p) => p.color);
    expect(order).toEqual([0x00ff00, 0x0000ff]);
  });

  it("projects a roof's triangles", () => {
    const roof: PartDraw = { color: 0x808080, boxes: [], tris: [0, 0, 0, 1, 0, 0, 0, 1, 1] };
    const [shape] = footprint([roof], 1, plan);
    expect(shape?.points.length).toBe(3);
    // Seen from above (x, z kept): (0,0), (1,0), (0,1).
    expect(shape?.points).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
  });

  it("draws nothing for no parts", () => {
    expect(footprint([], 1, plan)).toEqual([]);
  });
});
