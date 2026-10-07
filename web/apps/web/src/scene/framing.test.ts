import { describe, expect, it } from "vitest";
import { ELEVATIONS, framePose, orbitStep, orthoHalfHeight } from "./framing.ts";

const box = { min: [0, 0, 0], max: [10, 4, 10] } as const;

describe("framing", () => {
  it("stands on the bearing's side, looking at the centre", () => {
    const pose = framePose(box, 0, 30, "north", 60, 16 / 9);
    expect(pose.target).toEqual([5, 2, 5]);
    // From the real north (project -z when north is north), raised 30 degrees.
    expect(pose.position[2]).toBeLessThan(0);
    expect(pose.position[0]).toBeCloseTo(5);
    const dx = pose.position[0] - 5;
    const dy = pose.position[1] - 2;
    const dz = pose.position[2] - 5;
    expect(Math.atan2(dy, Math.hypot(dx, dz)) * (180 / Math.PI)).toBeCloseTo(30);
  });

  it("follows the project's north", () => {
    // The project's +x is the real north: standing north means standing at +x.
    const pose = framePose(box, 0, 30, "east", 60, 1);
    expect(pose.position[0]).toBeGreaterThan(10);
    expect(pose.position[2]).toBeCloseTo(5);
  });

  it("backs off further for a narrower view, and fits from straight above", () => {
    const wide = framePose(box, 45, ELEVATIONS.iso, "north", 60, 2);
    const narrow = framePose(box, 45, ELEVATIONS.iso, "north", 60, 0.5);
    const dist = (p: readonly [number, number, number]) => Math.hypot(p[0] - 5, p[1] - 2, p[2] - 5);
    expect(dist(narrow.position)).toBeGreaterThan(dist(wide.position));
    const top = framePose(box, 0, ELEVATIONS.top, "north", 60, 1);
    expect(top.position[1]).toBeGreaterThan(10);
  });

  it("sizes an orthographic view to the box", () => {
    const half = orthoHalfHeight(box, [0, -1, 0.001], 1, 1);
    expect(half).toBeCloseTo(5, 1);
  });

  it("orbits about the vertical at the same height and distance", () => {
    const next = orbitStep([10, 7, 0], [0, 0, 0], Math.PI / 2);
    expect(next[0]).toBeCloseTo(0);
    expect(next[1]).toBe(7);
    expect(next[2]).toBeCloseTo(-10);
  });
});
