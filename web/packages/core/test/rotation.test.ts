import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonical,
  compose,
  facingOf,
  IDENTITY,
  inverse,
  matrixOf,
  mirror,
  ROTATION_COUNT,
  rotate,
  rotationFacing,
  SYMMETRY,
  turn,
  turnClockwise,
  upOf,
} from "../src/index.ts";

const rotation = fc.integer({ min: 0, max: ROTATION_COUNT - 1 });
const axis = fc.constantFrom(0 as const, 1 as const, 2 as const);

describe("rotations", () => {
  it("number the 24 distinct proper rotations with the identity first", () => {
    expect(matrixOf(IDENTITY)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const keys = new Set(Array.from({ length: ROTATION_COUNT }, (_, r) => matrixOf(r).join()));
    expect(keys.size).toBe(24);
  });

  it("form a group: closed, associative, with inverses", () => {
    fc.assert(
      fc.property(rotation, rotation, rotation, (a, b, c) => {
        expect(compose(compose(a, b), c)).toBe(compose(a, compose(b, c)));
        expect(compose(a, inverse(a))).toBe(IDENTITY);
        expect(compose(IDENTITY, a)).toBe(a);
      }),
    );
  });

  it("compose applies the right-hand rotation first", () => {
    fc.assert(
      fc.property(rotation, rotation, (a, b) => {
        const v = [1, 2, 3] as const;
        expect(rotate(compose(a, b), v)).toEqual(rotate(a, rotate(b, v)));
      }),
    );
  });

  it("turns: four quarter turns are the identity; clockwise goes north to east", () => {
    fc.assert(
      fc.property(axis, (ax) => {
        const q = turn(ax, 1);
        expect(compose(q, compose(q, compose(q, q)))).toBe(IDENTITY);
      }),
    );
    expect(facingOf(turnClockwise(1))).toEqual([1, 0, 0]);
    expect(facingOf(turnClockwise(2))).toEqual([0, 0, 1]);
    expect(facingOf(turn(1, 1))).toEqual([-1, 0, 0]);
  });

  it("finds the rotation for any front and up, so every facing exists upright and upside-down", () => {
    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const;
    for (const front of dirs) {
      for (const up of [
        [0, 1, 0],
        [0, -1, 0],
      ] as const) {
        const r = rotationFacing(front, up);
        expect(facingOf(r)).toEqual(front);
        expect(upOf(r)).toEqual(up);
      }
    }
  });

  it("mirroring twice gives the rotation back, and a mirror flips facing across the plane", () => {
    fc.assert(
      fc.property(rotation, axis, axis, (r, world, model) => {
        expect(mirror(mirror(r, world, model), world, model)).toBe(r);
      }),
    );
    // Stairs facing east, mirrored across the X plane, face west and stay upright.
    const east = rotationFacing([1, 0, 0], [0, 1, 0]);
    const m = mirror(east, 0);
    expect(facingOf(m)).toEqual([-1, 0, 0]);
    expect(upOf(m)).toEqual([0, 1, 0]);
    // Mirroring across the Y plane turns them upside-down, not round.
    const flipped = mirror(east, 1);
    expect(facingOf(flipped)).toEqual([1, 0, 0]);
    expect(upOf(flipped)).toEqual([0, -1, 0]);
  });

  it("canonical rotations collapse lookalikes: a cube to one, a log to three axes", () => {
    const cube = new Set(Array.from({ length: 24 }, (_, r) => canonical(r, SYMMETRY.all)));
    expect(cube).toEqual(new Set([IDENTITY]));
    const log = new Set(Array.from({ length: 24 }, (_, r) => canonical(r, SYMMETRY.axisY)));
    expect(log.size).toBe(3);
    const stairs = new Set(Array.from({ length: 24 }, (_, r) => canonical(r, SYMMETRY.none)));
    expect(stairs.size).toBe(24);
  });
});
