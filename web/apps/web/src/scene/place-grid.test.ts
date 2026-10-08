import { placementGrid } from "@voxyl/shapes";
import { describe, expect, it } from "vitest";
import { gridPoints } from "./place-grid.ts";

describe("placement grid", () => {
  it("has no zones for an architecture shape and some for each microblock family", () => {
    expect(placementGrid("roof_tile").length).toBe(0);
    expect(placementGrid("face1").length / 4).toBe(12);
    expect(placementGrid("hollow2").length / 4).toBe(12);
    expect(placementGrid("corner2").length / 4).toBe(6);
    expect(placementGrid("edge1").length / 4).toBe(8);
  });

  it("lies in the plane of the aimed face, a hair above it", () => {
    // The top (side 1) of cell 2,3,4, hit at its top: every point has y = 4 + the lift.
    const points = gridPoints(
      { cell: [2, 3, 4], side: 1, point: [2.4, 4, 4.6], shape: "face1" },
      placementGrid("face1"),
    );
    for (let i = 1; i < points.length; i += 3) expect(points[i]).toBeCloseTo(4.004, 4);
    const xs = Array.from({ length: points.length / 3 }, (_, i) => points[i * 3] ?? 0);
    expect(Math.min(...xs)).toBeCloseTo(2, 4);
    expect(Math.max(...xs)).toBeCloseTo(3, 4);
  });
});
