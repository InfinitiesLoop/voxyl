import { DIRECTIONS } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { clockLabel, skyAt, wrapHours } from "./sky-model.ts";

function close(a: readonly number[], b: readonly number[]): void {
  for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] ?? Number.NaN, 6);
}

describe("skyAt", () => {
  it("rises in the project's real east, stands overhead at noon and sets in the west", () => {
    // The project's real east and west in (x, z), for each choice of north.
    const realEast = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] } as const;
    for (const north of DIRECTIONS) {
      const [ex, ez] = realEast[north];
      close(skyAt(6, north).sun, [ex, 0, ez]);
      close(skyAt(12, north).sun, [0, 1, 0]);
      close(skyAt(18, north).sun, [-ex, 0, -ez]);
      close(skyAt(0, north).sun, [0, -1, 0]);
      // The sky turns about real north: perpendicular to east, level.
      const pole = skyAt(9, north).pole;
      expect(pole[0] * ex + pole[2] * ez).toBeCloseTo(0, 9);
      expect(pole[1]).toBe(0);
    }
  });

  it("darkens like Minecraft: full light by day, none at night, no stars by day", () => {
    const noon = skyAt(12, "north");
    const midnight = skyAt(0, "north");
    expect(noon.daylight).toBe(1);
    expect(midnight.daylight).toBe(0);
    expect(noon.stars).toBe(0);
    expect(midnight.stars).toBeCloseTo(0.5, 9);
    expect(midnight.zenith).toEqual([0, 0, 0]);
    // Minecraft's plains sky at noon.
    close(noon.zenith, [0x78 / 255, 0xa7 / 255, 0xff / 255]);
    expect(midnight.horizon[2]).toBeGreaterThan(midnight.horizon[0]);
  });

  it("glows at sunrise and sunset on the sun's side, never at noon or midnight", () => {
    expect(skyAt(12, "north").glowAlpha).toBe(0);
    expect(skyAt(0, "north").glowAlpha).toBe(0);
    const dawn = skyAt(6, "north");
    expect(dawn.glowAlpha).toBeCloseTo(1, 6);
    close(dawn.glowSide, [1, 0, 0]);
    close(skyAt(18, "north").glowSide, [-1, 0, 0]);
    // Orange at the horizon.
    expect(dawn.glow[0]).toBeGreaterThan(dawn.glow[1]);
  });
});

describe("clock", () => {
  it("wraps and labels hours", () => {
    expect(wrapHours(25)).toBe(1);
    expect(wrapHours(-1)).toBe(23);
    expect(clockLabel(6.5)).toBe("06:30");
    expect(clockLabel(0)).toBe("00:00");
    expect(clockLabel(23.999)).toBe("00:00");
  });
});
