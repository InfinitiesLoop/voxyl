import { describe, expect, it } from "vitest";
import { orientationFor, turnedOrientation } from "../views/plane.ts";
import { compassPoint, cutLabels, northHeading, viewCompass } from "./compass.ts";

const QUARTER = Math.PI / 2;

describe("compass", () => {
  it("puts north up when the camera looks north", () => {
    expect(northHeading(0, "north")).toBeCloseTo(0);
  });

  it("puts north to the left when looking east, and to the right when looking west", () => {
    // Yaw turns left: a quarter turn from -z faces -x (west).
    expect(northHeading(-QUARTER, "north")).toBeCloseTo(-QUARTER);
    expect(northHeading(QUARTER, "north")).toBeCloseTo(QUARTER);
  });

  it("follows the project's north", () => {
    // The project's east is the real north: looking toward +x is looking north.
    expect(northHeading(-QUARTER, "east")).toBeCloseTo(0);
    expect(Math.abs(northHeading(0, "south"))).toBeCloseTo(Math.PI);
  });

  it("keeps north up on a plan until the view turns, and swaps east when mirrored", () => {
    const plan = orientationFor(1, "north");
    expect(viewCompass(plan, 1, "north")).toEqual({ heading: 0, mirrored: false });
    const turned = viewCompass(turnedOrientation(plan, 1, false), 1, "north");
    expect(turned?.heading).toBeCloseTo(Math.PI / 2);
    expect(turned?.mirrored).toBe(false);
    const flipped = viewCompass(turnedOrientation(plan, 0, true), 1, "north");
    expect(flipped?.heading).toBeCloseTo(0);
    expect(flipped?.mirrored).toBe(true);
    // The project's east is the real north, and an unturned plan still puts that at the top.
    expect(viewCompass(orientationFor(1, "east"), 1, "east")?.heading).toBeCloseTo(0);
  });

  it("names a cut's left and right, and up and down once the cut is turned", () => {
    const cut = orientationFor(0, "north");
    expect(cutLabels(cut, 0, "north")).toEqual({ left: "N", right: "S" });
    expect(cutLabels(turnedOrientation(cut, 1, false), 0, "north")).toEqual({
      left: "down",
      right: "up",
    });
  });

  it("names directions in the project's axes", () => {
    expect(compassPoint(0, -1, "north")).toBe("N");
    expect(compassPoint(1, 0, "north")).toBe("E");
    expect(compassPoint(0, 1, "north")).toBe("S");
    expect(compassPoint(-1, 0, "north")).toBe("W");
    expect(compassPoint(1, 0, "east")).toBe("N");
    expect(compassPoint(0, 1, "east")).toBe("E");
  });
});
