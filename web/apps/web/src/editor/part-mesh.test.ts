import { describe, expect, it } from "vitest";
import type { SurfaceParts } from "../world/clipboard.ts";
import { partMesh } from "./part-mesh.ts";

const one = (shape: string, slot: number, at = [0, 0, 0]): SurfaceParts => ({
  positions: Int32Array.from(at),
  colors: Uint8Array.from([255, 255, 255]),
  shapes: [shape],
  slots: Uint8Array.from([slot]),
});

/** The box the mesh's vertices span. */
function bounds(positions: Float32Array) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3;
    lo[a] = Math.min(lo[a] ?? 0, positions[i] ?? 0);
    hi[a] = Math.max(hi[a] ?? 0, positions[i] ?? 0);
  }
  return { lo, hi };
}

describe("partMesh", () => {
  it("draws a microblock as its box, 12 triangles", () => {
    // A slab (4 eighths) against a side fills half a cell.
    const mesh = partMesh(one("face4", 0), [0, 0, 0]);
    expect(mesh.positions.length / 9).toBe(12);
    const { lo, hi } = bounds(mesh.positions);
    const thickness = [0, 1, 2].map((a) => (hi[a] ?? 0) - (lo[a] ?? 0));
    expect(thickness.sort()).toEqual([0.5, 1, 1]);
  });

  it("winds every triangle outward, along its normal", () => {
    const mesh = partMesh(one("face4", 0), [0, 0, 0]);
    for (let t = 0; t < mesh.positions.length; t += 9) {
      const p = (k: number) => mesh.positions[t + k] ?? 0;
      const ux = p(3) - p(0);
      const uy = p(4) - p(1);
      const uz = p(5) - p(2);
      const vx = p(6) - p(0);
      const vy = p(7) - p(1);
      const vz = p(8) - p(2);
      const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const dot = cross.reduce((sum, c, a) => sum + c * (mesh.normals[t + a] ?? 0), 0);
      expect(dot).toBeGreaterThan(0);
    }
  });

  it("draws a roof shape from its triangles, inside its cell", () => {
    const mesh = partMesh(one("roof_tile", 0, [3, 4, 5]), [3, 4, 5]);
    expect(mesh.positions.length).toBeGreaterThan(0);
    const { lo, hi } = bounds(mesh.positions);
    for (let a = 0; a < 3; a++) {
      expect(lo[a]).toBeGreaterThanOrEqual(0);
      expect(hi[a]).toBeLessThanOrEqual(1);
    }
  });

  it("places a part relative to the origin", () => {
    const mesh = partMesh(one("face4", 0, [4, 0, 0]), [4, 0, 0]);
    expect(bounds(mesh.positions).lo[0]).toBe(0);
  });

  it("converts sRGB to linear colour", () => {
    const parts = { ...one("face4", 0), colors: Uint8Array.from([0, 128, 255]) };
    const mesh = partMesh(parts, [0, 0, 0]);
    expect(mesh.colors[0]).toBe(0);
    expect(mesh.colors[1]).toBeCloseTo(0.2158, 3);
    expect(mesh.colors[2]).toBeCloseTo(1, 5);
  });
});
