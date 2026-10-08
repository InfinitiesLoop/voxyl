import { DIRECTIONS } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  orientationFor,
  planeToScreen,
  planeToWorld,
  type SliceAxis,
  screenToPlane,
  turnedOrientation,
  worldToPlane,
} from "./plane.ts";

const AXES: SliceAxis[] = [0, 1, 2];

describe("2D view planes", () => {
  it("round-trips world and plane coordinates", () => {
    for (const axis of AXES) {
      const p = [3, -7, 11] as const;
      const [u, v, depth] = worldToPlane(axis, p);
      expect(planeToWorld(axis, depth, u, v)).toEqual([...p]);
    }
  });

  it("round-trips screen and plane cells in every orientation", () => {
    for (const axis of AXES)
      for (const north of DIRECTIONS) {
        const o = orientationFor(axis, north);
        for (const [s, t] of [
          [0, 0],
          [-1, 5],
          [12, -9],
        ] as const) {
          const [u, v] = screenToPlane(o, s, t);
          expect(planeToScreen(o, u, v)).toEqual([s, t]);
        }
      }
  });

  it("puts the project's real north at the top of a plan, east to the right", () => {
    // Moving one cell right on screen moves one cell real east; one cell up, real north.
    const realEast = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] } as const;
    const realNorth = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as const;
    for (const north of DIRECTIONS) {
      const o = orientationFor(1, north);
      const [u0, v0] = screenToPlane(o, 0, 0);
      const [u1, v1] = screenToPlane(o, 1, 0);
      const [u2, v2] = screenToPlane(o, 0, -1);
      expect([u1 - u0, v1 - v0]).toEqual([...realEast[north]]);
      expect([u2 - u0, v2 - v0]).toEqual([...realNorth[north]]);
    }
  });

  it("shows up as up on cuts", () => {
    for (const axis of [0, 2] as const) {
      const o = orientationFor(axis, "north");
      const [, v0] = screenToPlane(o, 0, 0);
      const [, v1] = screenToPlane(o, 0, -1);
      expect(v1 - v0).toBe(1);
    }
  });

  it("turns and mirrors a view, and still round-trips", () => {
    const o = orientationFor(1, "north");
    // A quarter turn clockwise: the real north, up before, points right.
    const turned = turnedOrientation(o, 1, false);
    const [u0, v0] = screenToPlane(turned, 0, 0);
    const [u1, v1] = screenToPlane(turned, 1, 0);
    expect([u1 - u0, v1 - v0]).toEqual([0, -1]);
    // Mirrored: east is on the left.
    const mirrored = turnedOrientation(o, 0, true);
    const [a0] = screenToPlane(mirrored, 0, 0);
    const [a1] = screenToPlane(mirrored, 1, 0);
    expect(a1 - a0).toBe(-1);
    for (const t of [0, 1, 2, 3])
      for (const m of [false, true]) {
        const x = turnedOrientation(o, t, m);
        const [u, v] = screenToPlane(x, 4, -3);
        expect(planeToScreen(x, u, v)).toEqual([4, -3]);
      }
    expect(turnedOrientation(o, 4, false)).toEqual(o);
  });
});
