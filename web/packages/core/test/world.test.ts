import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chunkKey, chunkKeyToCoords, EMPTY_ID, MAX_WORLD_COORD, World } from "../src/index.ts";

describe("World", () => {
  it("stores cells on both sides of chunk boundaries, including negative coordinates", () => {
    const world = new World();
    world.set(-1, 0, 0, { semantic: "Mass" });
    world.set(0, 0, 0, { semantic: "Trim" });
    world.set(31, -33, 32, { semantic: "Glow" });
    expect(world.get(-1, 0, 0)?.semantic).toBe("Mass");
    expect(world.get(0, 0, 0)?.semantic).toBe("Trim");
    expect(world.get(31, -33, 32)?.semantic).toBe("Glow");
    expect(world.get(1, 0, 0)).toBeNull();
    expect(world.cellCount).toBe(3);
    expect(world.chunkCount).toBe(3);
  });

  it("counts overwrites once and reports no-op writes", () => {
    const world = new World();
    expect(world.set(5, 5, 5, { semantic: "Mass" })).toBe(true);
    expect(world.set(5, 5, 5, { semantic: "Mass" })).toBe(false);
    expect(world.set(5, 5, 5, { semantic: "Trim" })).toBe(true);
    expect(world.cellCount).toBe(1);
    expect(world.set(6, 5, 5, null)).toBe(false);
  });

  it("drops a chunk once its last cell is cleared", () => {
    const world = new World();
    world.set(40, 0, 0, { semantic: "Mass" });
    expect(world.chunkCount).toBe(1);
    world.set(40, 0, 0, null);
    expect(world.chunkCount).toBe(0);
    expect(world.cellCount).toBe(0);
  });

  it("reports each changed chunk once, then starts clean", () => {
    const world = new World();
    world.set(0, 0, 0, { semantic: "Mass" });
    world.set(1, 0, 0, { semantic: "Mass" });
    world.set(-1, 0, 0, { semantic: "Mass" });
    expect(world.takeDirtyChunks().sort()).toEqual([chunkKey(-1, 0, 0), chunkKey(0, 0, 0)].sort());
    expect(world.takeDirtyChunks()).toEqual([]);
    world.set(-1, 0, 0, null);
    expect(world.takeDirtyChunks()).toEqual([chunkKey(-1, 0, 0)]);
  });

  it("visits every cell at its world position", () => {
    const world = new World();
    const placed = [
      [0, 0, 0],
      [-1, 40, -33],
      [31, 31, 31],
      [32, -32, 5],
    ] as const;
    for (const [x, y, z] of placed) {
      world.set(x, y, z, { semantic: `S${x},${y},${z}` });
    }
    const visited: string[] = [];
    world.forEachCell((x, y, z, id) => {
      expect(world.states.get(id)?.semantic).toBe(`S${x},${y},${z}`);
      visited.push(`${x},${y},${z}`);
    });
    expect(visited.sort()).toEqual(placed.map((p) => p.join(",")).sort());
  });

  it("rejects positions outside the world and unknown state ids", () => {
    const world = new World();
    expect(() => world.set(MAX_WORLD_COORD + 1, 0, 0, { semantic: "Mass" })).toThrow(RangeError);
    expect(() => world.setId(0, 0, 0, 42)).toThrow(RangeError);
  });

  it("matches a plain map model under random edits", () => {
    const coord = fc.integer({ min: -70, max: 70 });
    const semantic = fc.constantFrom("Mass", "Trim", "Glow", null);
    const edit = fc.tuple(coord, coord, coord, semantic);
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 300 }), (edits) => {
        const world = new World();
        const model = new Map<string, string>();
        for (const [x, y, z, s] of edits) {
          world.set(x, y, z, s === null ? null : { semantic: s });
          if (s === null) {
            model.delete(`${x},${y},${z}`);
          } else {
            model.set(`${x},${y},${z}`, s);
          }
        }
        expect(world.cellCount).toBe(model.size);
        for (const [x, y, z] of edits) {
          const expected = model.get(`${x},${y},${z}`) ?? null;
          expect(world.get(x, y, z)?.semantic ?? null).toBe(expected);
        }
        // Every stored chunk holds cells, and their counts add up to the world's.
        let chunkCells = 0;
        for (const key of world.chunkKeys()) {
          const count = world.chunk(...chunkKeyToCoords(key))?.count ?? 0;
          expect(count).toBeGreaterThan(0);
          chunkCells += count;
        }
        expect(chunkCells).toBe(world.cellCount);
        expect(world.getId(1000, 1000, 1000)).toBe(EMPTY_ID);
      }),
    );
  });
});
