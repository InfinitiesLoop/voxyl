import { describe, expect, it } from "vitest";
import { raycast, World } from "../src/index.ts";

const MASS = 1;

describe("raycast", () => {
  const world = new World();
  const mass = world.states.intern({ semantic: MASS });
  world.setId(5, 0, 0, mass);
  world.setId(-3, 2, -7, mass);

  it("hits the first occupied cell and reports the face it entered", () => {
    const hit = raycast(world, [0.5, 0.5, 0.5], [1, 0, 0], 100);
    expect(hit?.cell).toEqual([5, 0, 0]);
    expect(hit?.normal).toEqual([-1, 0, 0]);
    expect(hit?.id).toBe(mass);
    expect(hit?.distance).toBeCloseTo(4.5);
  });

  it("finds cells at negative coordinates", () => {
    const down = raycast(world, [-2.5, 10.5, -6.5], [0, -1, 0], 100);
    expect(down?.cell).toEqual([-3, 2, -7]);
    expect(down?.normal).toEqual([0, 1, 0]);
    expect(down?.distance).toBeCloseTo(7.5);
    const diagonal = raycast(world, [0.5, 5.5, -3.5], [-1, -1, -1], 100);
    expect(diagonal?.cell).toEqual([-3, 2, -7]);
    expect(diagonal?.distance).toBeCloseTo(2.5);
  });

  it("stops at the maximum distance", () => {
    expect(raycast(world, [0.5, 0.5, 0.5], [1, 0, 0], 4)).toBeNull();
    expect(raycast(world, [0.5, 0.5, 0.5], [-1, 0, 0], 50)).toBeNull();
  });

  it("reports a zero normal when the ray starts inside a cell", () => {
    const hit = raycast(world, [5.5, 0.5, 0.5], [0, 1, 0], 10);
    expect(hit?.cell).toEqual([5, 0, 0]);
    expect(hit?.normal).toEqual([0, 0, 0]);
  });

  it("reports the point it met", () => {
    const hit = raycast(world, [0.5, 0.5, 0.5], [1, 0, 0], 100);
    expect(hit?.point[0]).toBeCloseTo(5);
    expect(hit?.point[1]).toBeCloseTo(0.5);
    expect(hit?.part).toBeUndefined();
  });

  describe("cells of parts", () => {
    const w = new World();
    // A slab (4/8) on the floor of cell 0,0,0 and a strip in the far corner of cell 3,0,0.
    const slab = w.states.intern({ parts: [{ semantic: MASS, shape: "face4", slot: 0 }] });
    const strip = w.states.intern({ parts: [{ semantic: MASS, shape: "edge1", slot: 0 }] });
    w.setId(0, 0, 0, slab);
    w.setId(3, 0, 0, strip);

    it("lands on the part, at its own height rather than the cell's", () => {
      const hit = raycast(w, [0.5, 5, 0.5], [0, -1, 0], 20);
      expect(hit?.cell).toEqual([0, 0, 0]);
      expect(hit?.part).toEqual({ index: 0, side: 1 });
      expect(hit?.point[1]).toBeCloseTo(0.5);
      expect(hit?.distance).toBeCloseTo(4.5);
    });

    it("passes over the open part of a cell", () => {
      // Level with the top half of the slab's cell: nothing there to hit.
      expect(raycast(w, [-2, 0.75, 0.5], [1, 0, 0], 10)).toBeNull();
      // The strip sits in one corner; a ray through the other corner reaches nothing.
      expect(raycast(w, [3.9, 5, 0.9], [0, -1, 0], 20)).toBeNull();
    });

    it("hits a part from the side it is on", () => {
      const hit = raycast(w, [-2, 0.25, 0.5], [1, 0, 0], 10);
      expect(hit?.cell).toEqual([0, 0, 0]);
      expect(hit?.part?.side).toBe(4);
    });
  });
});
