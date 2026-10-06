import { describe, expect, it } from "vitest";
import {
  ARCH_SHAPES,
  ARCH_SLOTS,
  MICRO_SHAPES,
  microSlotCount,
  slotsLookAlike,
  transformSlot,
} from "../src/index.ts";

// Clockwise quarter turn seen from above (north -Z to east +X), and mirrors.
const TURN = [0, 0, -1, 0, 1, 0, 1, 0, 0];
const MIRROR_X = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
const MIRROR_Y = [1, 0, 0, 0, -1, 0, 0, 0, 1];
const TILT = [1, 0, 0, 0, 0, -1, 0, 1, 0]; // a quarter turn about X

function slotsOf(shape: string): number[] {
  const n = shape in MICRO_SHAPES ? microSlotCount(shape) : ARCH_SLOTS;
  return Array.from({ length: n }, (_, i) => i);
}

const ALL = [...Object.keys(MICRO_SHAPES), ...Object.keys(ARCH_SHAPES)];

describe("slot transforms", () => {
  it("turns a north-facing cover to the east", () => {
    expect(transformSlot("face1", 2, TURN)).toBe(5); // -Z to +X
    expect(transformSlot("face1", 0, TURN)).toBe(0); // the floor stays the floor
    expect(transformSlot("face1", 0, MIRROR_Y)).toBe(1); // floor to ceiling
  });

  it.each(ALL)(
    "%s: every slot has an image under any rotation, and four turns are none",
    (shape) => {
      for (const slot of slotsOf(shape)) {
        for (const m of [TURN, TILT]) {
          let s: number | null = slot;
          for (let i = 0; i < 4; i++) {
            s = transformSlot(shape, s as number, m);
            expect(s).not.toBeNull();
          }
          expect(s).toBe(slot);
        }
      }
    },
  );

  it.each(ALL)("%s: mirroring twice gives the slot back", (shape) => {
    for (const slot of slotsOf(shape)) {
      for (const m of [MIRROR_X, MIRROR_Y]) {
        const once = transformSlot(shape, slot, m);
        if (once === null) continue; // a chiral shape: reported by the caller
        const back = transformSlot(shape, once, m);
        expect(back !== null && slotsLookAlike(shape, back, slot)).toBe(true);
      }
    }
  });

  it("mirrors every microblock (they are all symmetric)", () => {
    for (const shape of Object.keys(MICRO_SHAPES)) {
      for (const slot of slotsOf(shape)) {
        expect(transformSlot(shape, slot, MIRROR_X)).not.toBeNull();
      }
    }
  });

  it("mirrors the symmetric roof shapes", () => {
    for (const shape of ["roof_tile", "roof_outer_corner", "roof_inner_corner", "roof_ridge"]) {
      for (let slot = 0; slot < ARCH_SLOTS; slot++) {
        expect(transformSlot(shape, slot, MIRROR_X)).not.toBeNull();
      }
    }
  });

  it("has no image for a shape it doesn't know", () => {
    expect(transformSlot("mystery", 0, TURN)).toBeNull();
  });
});
