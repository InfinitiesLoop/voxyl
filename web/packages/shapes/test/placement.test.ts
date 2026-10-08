import { describe, expect, it } from "vitest";
import {
  ARCH_SHAPES,
  hitPart,
  hitSlot,
  isValidSlot,
  MICRO_SHAPES,
  oppositeSlot,
  orientOnPlacement,
  type PlacementWorld,
  type RulePart,
  resolvePlacement,
  SHAPE_PAGES,
  shapeName,
  slotName,
  usesOpposite,
  type Vec3,
} from "../src/index.ts";

/** A world of cells by "x,y,z": parts, or null for a whole block. Anything else is empty. */
function worldOf(cells: Record<string, readonly RulePart[] | null>): PlacementWorld {
  return {
    parts: (cell) => {
      const key = cell.join(",");
      return key in cells ? (cells[key] ?? null) : [];
    },
  };
}

describe("which slot a click picks", () => {
  it("picks a face slot from the zone of the face that was hit", () => {
    // Clicking the middle of a face (side 1, +Y) picks the slab lying against that face.
    expect(hitSlot("face1", [0.5, 1, 0.5], 1)).toBe(0);
    // Near the +X edge of that face: a slab against +X (side 5).
    expect(hitSlot("face1", [0.95, 1, 0.5], 1)).toBe(5);
    expect(hitSlot("face1", [0.5, 1, 0.05], 1)).toBe(2);
  });

  it("picks a corner by the quadrant, and an edge by the zone", () => {
    const corner = hitSlot("corner1", [0.9, 1, 0.9], 1);
    expect(slotName("corner1", corner)).toBe("down-south-east");
    expect(hitSlot("edge1", [0.5, 1, 0.5], 1)).toBe(-1); // the centre zone
    // The +Z edge zone of the top face: the part goes in the cell above, so it lies along that
    // cell's bottom (down) edge on the south side.
    expect(slotName("edge1", hitSlot("edge1", [0.5, 1, 0.9], 1))).toBe("down-south");
    // Near the +X +Z corner of that face: the vertical edge there, running along Y.
    expect(slotName("edge1", hitSlot("edge1", [0.9, 1, 0.9], 1))).toBe("south-east");
  });

  it("mirrors a slot across the clicked axis", () => {
    expect(oppositeSlot("face1", 0, 1)).toBe(1);
    const e = hitSlot("edge1", [0.5, 1, 0.9], 1);
    const far = oppositeSlot("edge1", e, 1);
    expect(far).not.toBe(e);
    expect(oppositeSlot("edge1", far, 1)).toBe(e);
    expect(oppositeSlot("edge2", 12, 1)).toBe(12); // a centred post has no far side
  });

  it("flips a face-family part only when it would lie flush with the clicked face", () => {
    expect(usesOpposite("face1", 0, 1)).toBe(true); // against the face you clicked
    expect(usesOpposite("face1", 2, 1)).toBe(false);
    expect(usesOpposite("edge1", 3, 1)).toBe(true);
  });
});

describe("resolving a click into a cell and a slot", () => {
  const empty = worldOf({});
  const strip = (slot: number): RulePart => ({ semantic: "A", shape: "edge1", slot });

  it("places beside a full block's face, on the near side", () => {
    // A block at 0,0,0 with the +Y face clicked: the part goes in the cell above it.
    const world = worldOf({ "0,0,0": null });
    const placed = resolvePlacement(world, "A", "face1", [0, 0, 0], [0.5, 1, 0.5], 1, false);
    expect(placed).toEqual({ cell: [0, 1, 0], slot: 0 });
    // With the opposite modifier it lies on the far side of that cell.
    const far = resolvePlacement(world, "A", "face1", [0, 0, 0], [0.5, 1, 0.5], 1, true);
    expect(far).toEqual({ cell: [0, 1, 0], slot: 1 });
  });

  it("places into the same cell when the inner face of a thin part is clicked", () => {
    // A slab on the floor of cell 0,0,0; click its top face, which sits halfway up the cell.
    const slab: RulePart = { semantic: "A", shape: "face4", slot: 0 };
    const world = worldOf({ "0,0,0": [slab] });
    const placed = resolvePlacement(world, "A", "face1", [0, 0, 0], [0.5, 0.5, 0.5], 1, false);
    expect(placed?.cell).toEqual([0, 0, 0]);
  });

  it("refuses a cell that holds a whole block, and a slot the rules reject", () => {
    const world = worldOf({ "0,1,0": null });
    expect(resolvePlacement(world, "A", "face1", [0, 0, 0], [0.5, 1, 0.5], 1, false)).toBeNull();
    const taken = worldOf({ "0,1,0": [{ semantic: "B", shape: "face1", slot: 0 }] });
    expect(resolvePlacement(taken, "A", "face1", [0, 0, 0], [0.5, 1, 0.5], 1, false)).toBeNull();
  });

  it("only centres a post from the middle of a face, and only for even sizes", () => {
    const middle: Vec3 = [0.5, 1, 0.5];
    expect(resolvePlacement(empty, "A", "edge1", [0, 0, 0], middle, 1, false)).toBeNull();
    expect(resolvePlacement(empty, "A", "edge2", [0, 0, 0], middle, 1, false)).toEqual({
      cell: [0, 1, 0],
      slot: 12,
    });
  });

  it("works with parts already in the cell", () => {
    const world = worldOf({ "0,1,0": [strip(0)] });
    const placed = resolvePlacement(world, "A", "edge1", [0, 0, 0], [0.9, 1, 0.9], 1, false);
    expect(placed).not.toBeNull();
    expect(placed?.slot).not.toBe(0);
  });

  it("gives every placement a valid slot", () => {
    const world = worldOf({ "0,0,0": null });
    for (const shape of Object.keys(MICRO_SHAPES)) {
      for (let side = 0; side < 6; side++) {
        for (const opposite of [false, true]) {
          const placed = resolvePlacement(
            world,
            "A",
            shape,
            [0, 0, 0],
            [0.3, 0.7, 0.6],
            side,
            opposite,
          );
          if (placed) expect(isValidSlot(shape, placed.slot)).toBe(true);
        }
      }
    }
  });
});

describe("architecture shapes", () => {
  it("sits a roof on the floor, turned toward the click", () => {
    // Clicking the top of a floor block (face 1): the base sits on it (side 0).
    const slot = orientOnPlacement("roof_tile", 1, [0.3, -0.5, 0], false, null);
    expect(slot >> 2).toBe(0);
    // Different click positions give different turns.
    const turns = new Set(
      (
        [
          [0.4, -0.5, 0],
          [-0.4, -0.5, 0],
          [0, -0.5, 0.4],
          [0, -0.5, -0.4],
        ] as Vec3[]
      ).map((hit) => orientOnPlacement("roof_tile", 1, hit, false, null) & 3),
    );
    expect(turns.size).toBe(4);
  });

  it("continues a neighbouring roof line", () => {
    const first = orientOnPlacement("roof_tile", 1, [0.4, -0.5, 0], false, null);
    // Clicking the side face of that roof (face 5, +X) lines the next tile up with it.
    const next = orientOnPlacement("roof_tile", 5, [0, 0, 0.45], false, {
      shape: "roof_tile",
      slot: first,
    });
    expect(next >> 2).toBe(first >> 2);
  });

  it("places an architecture shape into the cell beside the clicked face", () => {
    const world = worldOf({ "0,0,0": null });
    const placed = resolvePlacement(world, "A", "roof_tile", [0, 0, 0], [0.5, 1, 0.5], 1, false);
    expect(placed?.cell).toEqual([0, 1, 0]);
    expect(placed && isValidSlot("roof_tile", placed.slot)).toBe(true);
  });
});

describe("aiming at a part", () => {
  it("meets a slab's top face, and passes over the empty rest of the cell", () => {
    // A slab on the floor (a quarter of the cell... face4 is 4/8 thick).
    const down = hitPart("face4", 0, [0.5, 2, 0.5], [0, -1, 0]);
    expect(down?.side).toBe(1);
    expect(down?.t).toBeCloseTo(1.5);
    // A ray at a slab on the +Y side, shot from below, hits its underside.
    const up = hitPart("face4", 1, [0.5, -1, 0.5], [0, 1, 0]);
    expect(up?.side).toBe(0);
    // A strip in a corner is missed by a ray down the opposite corner.
    expect(hitPart("edge1", 0, [0.9, 2, 0.9], [0, -1, 0])).toBeNull();
  });

  it("hits the sloped face of a roof", () => {
    const hit = hitPart("roof_tile", 0, [0.5, 2, 0.5], [0, -1, 0]);
    expect(hit).not.toBeNull();
    expect(hit?.t).toBeGreaterThan(0.9);
    expect(hit?.t).toBeLessThan(1.6);
  });
});

describe("the shape pages", () => {
  it("lists every shape once, with a name", () => {
    const ids = SHAPE_PAGES.flatMap((p) => p.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(Object.keys(MICRO_SHAPES).length + Object.keys(ARCH_SHAPES).length);
    for (const id of ids) expect(shapeName(id)).not.toBe(id);
  });
});
