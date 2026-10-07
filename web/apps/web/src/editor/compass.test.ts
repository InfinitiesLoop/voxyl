import { describe, expect, it } from "vitest";
import { compassPoint, northHeading } from "./compass.ts";

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

  it("names directions in the project's axes", () => {
    expect(compassPoint(0, -1, "north")).toBe("N");
    expect(compassPoint(1, 0, "north")).toBe("E");
    expect(compassPoint(0, 1, "north")).toBe("S");
    expect(compassPoint(-1, 0, "north")).toBe("W");
    expect(compassPoint(1, 0, "east")).toBe("N");
    expect(compassPoint(0, 1, "east")).toBe("E");
  });
});
