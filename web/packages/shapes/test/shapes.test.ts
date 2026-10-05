import { describe, expect, it } from "vitest";
import {
  ARCH_SHAPES,
  archRotation,
  archSlot,
  archTriangles,
  edgeBetween,
  MICRO_SHAPES,
  microBoxes,
  microSlotCount,
} from "../src/index.ts";

describe("microblocks", () => {
  it("places faces against their side", () => {
    expect(microBoxes("face1", 0)).toEqual([[0, 0, 0, 8, 1, 8]]); // -Y
    expect(microBoxes("face2", 3)).toEqual([[0, 0, 6, 8, 8, 8]]); // +Z
    expect(microBoxes("face4", 4)).toEqual([[0, 0, 0, 4, 8, 8]]); // -X
  });

  it("numbers edges and posts as the Godot app does", () => {
    expect(microBoxes("edge1", 0)).toEqual([[0, 0, 0, 1, 8, 1]]); // along Y at -X -Z
    expect(microBoxes("edge2", 3)).toEqual([[6, 0, 6, 8, 8, 8]]); // along Y at +X +Z
    expect(microBoxes("edge1", 8)).toEqual([[0, 0, 0, 8, 1, 1]]); // along X at -Y -Z
    expect(microBoxes("edge4", 12)).toEqual([[2, 0, 2, 6, 8, 6]]); // a centered pillar along Y
    expect(microSlotCount("edge1")).toBe(12);
    expect(microSlotCount("edge2")).toBe(15);
  });

  it("finds the edge between two sides (ShapeCatalog's table)", () => {
    // _EDGE_BETWEEN in ShapeCatalog.gd, indexed s1 * 6 + s2 with s1 < s2.
    const table = [
      -1, -1, 8, 10, 4, 5, -1, -1, 9, 11, 6, 7, -1, -1, -1, -1, 0, 2, -1, -1, -1, -1, 1, 3,
    ];
    table.forEach((want, i) => {
      const s1 = Math.floor(i / 6);
      const s2 = i % 6;
      if (want < 0) return;
      expect(edgeBetween(s1, s2)).toBe(want);
      expect(edgeBetween(s2, s1)).toBe(want);
    });
  });

  it("makes a hollow cover a ring of four boxes", () => {
    const boxes = microBoxes("hollow1", 1);
    expect(boxes.length).toBe(4);
    const area = boxes.reduce((s, b) => s + (b[3] - b[0]) * (b[5] - b[2]), 0);
    expect(area).toBe(64 - 16);
  });

  it("returns nothing for unknown shapes or slots", () => {
    expect(microBoxes("face1", 6)).toEqual([]);
    expect(microBoxes("nope", 0)).toEqual([]);
    expect(Object.keys(MICRO_SHAPES).length).toBe(12);
  });
});

describe("architecture shapes", () => {
  it("has 24 distinct proper rotations", () => {
    const seen = new Set<string>();
    for (let side = 0; side < 6; side++) {
      for (let turn = 0; turn < 4; turn++) {
        const m = archRotation(side, turn);
        const det =
          m[0] * (m[4] * m[8] - m[5] * m[7]) -
          m[1] * (m[3] * m[8] - m[5] * m[6]) +
          m[2] * (m[3] * m[7] - m[4] * m[6]);
        expect(det).toBe(1);
        seen.add(m.join(","));
      }
    }
    expect(seen.size).toBe(24);
  });

  it("puts a shape's base on the side its slot names", () => {
    // The roof tile's bottom quad lies on the side the slot says its base sits on.
    const sideAxis = [1, 1, 2, 2, 0, 0];
    const sidePlane = [0, 1, 0, 1, 0, 1];
    for (let side = 0; side < 6; side++) {
      const t = archTriangles("roof_tile", archSlot(side, 0));
      let onBase = 0;
      for (let i = 0; i < t.length; i += 9) {
        const axis = sideAxis[side] ?? 0;
        const plane = sidePlane[side] ?? 0;
        if ([0, 3, 6].every((k) => Math.abs((t[i + k + axis] ?? 0) - plane) < 1e-9)) onBase++;
      }
      expect(onBase, `side ${side}`).toBe(2);
    }
  });

  it("keeps every shape inside its cell in every orientation", () => {
    for (const shape of Object.keys(ARCH_SHAPES)) {
      for (let slot = 0; slot < 24; slot++) {
        const t = archTriangles(shape, slot);
        expect(t.length, shape).toBeGreaterThan(0);
        for (const c of t) {
          expect(c).toBeGreaterThanOrEqual(-1e-9);
          expect(c).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });
});
