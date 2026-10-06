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
});
