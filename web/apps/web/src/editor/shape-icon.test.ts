import { ARCH_SHAPES, MICRO_SHAPES } from "@voxyl/shapes";
import { describe, expect, it } from "vitest";
import { iconSlot, shapeIcon } from "./shape-icon.ts";

describe("shape icons", () => {
  it("draws every known shape", () => {
    for (const shape of [...Object.keys(MICRO_SHAPES), ...Object.keys(ARCH_SHAPES)]) {
      const polygons = shapeIcon(shape, iconSlot(shape));
      expect(polygons.length, shape).toBeGreaterThan(0);
      for (const p of polygons) {
        for (const pair of p.points.split(" ")) {
          const [x, y] = pair.split(",").map(Number);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(100);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("shows a slab's top, and its two sides", () => {
    const shades = new Set(shapeIcon("face4", 0).map((p) => p.shade));
    expect([...shades].sort()).toEqual([0, 1, 2]);
  });

  it("draws nothing for an unknown shape", () => {
    expect(shapeIcon("mystery")).toEqual([]);
  });

  it("draws a thin shape smaller than a thick one", () => {
    const area = (shape: string) =>
      shapeIcon(shape, 0).reduce((total, p) => {
        const pts = p.points
          .split(" ")
          .map((pair) => pair.split(",").map(Number) as [number, number]);
        const [a, b, c] = pts as [[number, number], [number, number], [number, number]];
        return total + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }, 0);
    expect(area("face1")).toBeLessThan(area("face4"));
  });
});
