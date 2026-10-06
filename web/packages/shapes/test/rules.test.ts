import { describe, expect, it } from "vitest";
import {
  MICRO_SHAPES,
  microSlotCount,
  type RulePart,
  rejectCell,
  rejectPart,
  slotFromName,
  slotName,
  slotNames,
  transformSlot,
} from "../src/index.ts";

const p = (semantic: string, shape: string, slot: number): RulePart => ({ semantic, shape, slot });
const ok = (existing: RulePart[], part: RulePart) => rejectPart(existing, part) === null;

describe("shape rules (the Godot smoke test's cases)", () => {
  it("accepts and refuses as Forge Microblocks does", () => {
    expect(ok([], p("A", "face1", 0))).toBe(true);
    expect(rejectPart([p("A", "face1", 0)], p("B", "face2", 0))).toBe("slot_taken");
    expect(ok([p("A", "hollow1", 0)], p("A", "face1", 0))).toBe(false);
    expect(ok([p("A", "face4", 0)], p("B", "face4", 1))).toBe(true);
    const strips = [p("A", "edge1", 0), p("A", "edge1", 1), p("A", "edge1", 2)];
    expect(ok(strips, p("A", "edge1", 3))).toBe(true);
    expect(rejectPart([p("A", "face1", 0)], p("A", "corner1", 0))).toBe("occluded");
    expect(ok([p("A", "face1", 0)], p("A", "edge1", 4))).toBe(false);
    expect(ok([p("A", "face1", 0)], p("A", "edge2", 4))).toBe(true);
    expect(ok([p("A", "edge2", 12)], p("A", "edge2", 13))).toBe(true);
    expect(ok([p("A", "edge2", 12)], p("B", "edge4", 12))).toBe(false);
    expect(ok([p("A", "edge4", 12)], p("A", "edge1", 0))).toBe(true);
    expect(ok([p("A", "edge4", 13)], p("A", "face4", 2))).toBe(true);
    expect(rejectPart([p("A", "edge4", 12)], p("A", "face4", 2))).toBe("hard_overlap");
    expect(ok([p("A", "hollow1", 0)], p("A", "edge2", 12))).toBe(true);
    expect(ok([p("A", "hollow1", 0)], p("A", "edge4", 12))).toBe(true);
    expect(rejectPart([], p("A", "nope", 0))).toBe("invalid_slot");
    expect(rejectPart([], p("A", "edge1", 12))).toBe("invalid_slot");
  });

  it("gives architecture shapes a cell to themselves", () => {
    expect(ok([], p("A", "roof_tile", 0))).toBe(true);
    expect(rejectPart([p("A", "face1", 0)], p("A", "roof_tile", 0))).toBe("exclusive");
    expect(rejectPart([p("A", "roof_tile", 0)], p("A", "face1", 1))).toBe("exclusive");
    expect(rejectPart([], p("A", "roof_tile", 24))).toBe("invalid_slot");
  });

  it("lets parts meet without burying each other", () => {
    expect(ok([p("A", "face4", 2)], p("A", "face4", 4))).toBe(true);
    expect(rejectPart([p("A", "face4", 2)], p("B", "edge4", 0))).toBe("occluded"); // buried
    expect(ok([p("A", "corner4", 0)], p("B", "corner4", 3))).toBe(true);
    expect(ok([p("A", "corner4", 0)], p("A", "corner4", 3))).toBe(true);
  });

  it("checks whole cells part by part", () => {
    expect(rejectCell([p("A", "face1", 0), p("A", "face1", 1), p("A", "edge2", 12)])).toBe(null);
    expect(rejectCell([p("A", "face1", 0), p("B", "face2", 0)])).toBe("slot_taken");
  });

  it("keeps a valid pair valid under every turn and mirror of the cell", () => {
    const shapes = Object.keys(MICRO_SHAPES);
    const mats = [
      [0, 0, 1, 0, 1, 0, -1, 0, 0],
      [1, 0, 0, 0, 0, -1, 0, 1, 0],
      [-1, 0, 0, 0, 1, 0, 0, 0, 1],
    ];
    let pairs = 0;
    for (const a of shapes)
      for (const b of shapes)
        for (let sa = 0; sa < microSlotCount(a); sa += 3)
          for (let sb = 0; sb < microSlotCount(b); sb += 2) {
            const pa = p("A", a, sa);
            const pb = p("B", b, sb);
            const verdict = rejectCell([pa, pb]) === null;
            for (const m of mats) {
              const moved = [pa, pb].map((q) => ({
                ...q,
                slot: transformSlot(q.shape, q.slot, m) ?? -1,
              }));
              expect(rejectCell(moved) === null).toBe(verdict);
            }
            pairs++;
          }
    expect(pairs).toBeGreaterThan(500);
  });
});

describe("slot names", () => {
  it("names slots as the Godot app does and reads them back", () => {
    expect(slotName("face1", 0)).toBe("down");
    expect(slotName("corner1", 7)).toBe("up-south-east");
    expect(slotName("edge2", 13)).toBe("center-z");
    expect(slotFromName("face2", "top")).toBe(1);
    expect(slotFromName("corner2", "east-up-south")).toBe(7);
    expect(slotFromName("edge1", "nowhere")).toBe(-1);
    expect(slotFromName("edge1", 4)).toBe(4);
    expect(slotName("roof_tile", 0)).toBe("up=up turn=0");
  });

  it("gives every slot a distinct name that reads back to it", () => {
    for (const shape of [...Object.keys(MICRO_SHAPES), "roof_tile", "slope_tile_c3"]) {
      const names = slotNames(shape);
      expect(new Set(names).size).toBe(names.length);
      for (const [slot, name] of names.entries()) expect(slotFromName(shape, name)).toBe(slot);
    }
  });
});
