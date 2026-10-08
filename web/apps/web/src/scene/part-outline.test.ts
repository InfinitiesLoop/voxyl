import { describe, expect, it } from "vitest";
import { partEdges } from "./part-outline.ts";

describe("part outlines", () => {
  it("traces a microblock's box inside its cell, at the cell's place in the world", () => {
    const points = partEdges([3, 4, 5], "face4", 0);
    // One box: twelve edges, two points each, three numbers a point.
    expect(points.length).toBe(12 * 2 * 3);
    for (let i = 0; i < points.length; i += 3) {
      expect(points[i]).toBeGreaterThanOrEqual(3 - 0.01);
      expect(points[i]).toBeLessThanOrEqual(4 + 0.01);
      // A slab against the bottom is half a cell tall.
      expect(points[i + 1]).toBeGreaterThanOrEqual(4 - 0.01);
      expect(points[i + 1]).toBeLessThanOrEqual(4.5 + 0.01);
      expect(points[i + 2]).toBeGreaterThanOrEqual(5 - 0.01);
      expect(points[i + 2]).toBeLessThanOrEqual(6 + 0.01);
    }
  });

  it("draws a hollow part as its four boxes", () => {
    expect(partEdges([0, 0, 0], "hollow1", 0).length).toBe(4 * 12 * 2 * 3);
  });

  it("traces an architecture shape's triangles", () => {
    const points = partEdges([0, 0, 0], "roof_tile", 0);
    expect(points.length).toBeGreaterThan(0);
    // Three segments a triangle, six numbers a segment.
    expect(points.length % 18).toBe(0);
  });

  it("draws nothing for an unknown shape", () => {
    expect(partEdges([0, 0, 0], "mystery", 0).length).toBe(0);
  });
});
