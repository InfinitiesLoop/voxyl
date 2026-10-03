import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chunkKey, chunkKeyToCoords, EMPTY_ID, MAX_CHUNK_BITS, World } from "../src/index.ts";

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

  it("marks only the changed chunk dirty for an interior edit", () => {
    const world = new World({ chunkBits: 4 });
    world.set(5, 5, 5, { semantic: "Mass" });
    expect(world.takeDirtyChunks()).toEqual([chunkKey(0, 0, 0)]);
    expect(world.takeDirtyChunks()).toEqual([]);
  });

  it("also marks the face neighbours an edit on a chunk boundary can expose", () => {
    const world = new World({ chunkBits: 4 });
    world.set(0, 15, 7, { semantic: "Mass" });
    expect(world.takeDirtyChunks().sort()).toEqual(
      [chunkKey(0, 0, 0), chunkKey(-1, 0, 0), chunkKey(0, 1, 0)].sort(),
    );
    world.set(0, 15, 7, null);
    expect(world.takeDirtyChunks().length).toBe(3);
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
    expect(() => world.set(world.layout.maxWorld + 1, 0, 0, { semantic: "Mass" })).toThrow(
      RangeError,
    );
    expect(() => world.setId(0, 0, 0, 42)).toThrow(RangeError);
    expect(() => world.fillBox(0, 0, 0, 1, 1, 1, 42)).toThrow(RangeError);
  });
});

describe("World.fillBox", () => {
  it("fills across chunks with corners in any order, then clears", () => {
    const world = new World({ chunkBits: 3 });
    const mass = world.states.intern({ semantic: "Mass" });
    expect(world.fillBox(5, 2, -3, -4, -1, 9, mass)).toBe(10 * 4 * 13);
    expect(world.cellCount).toBe(520);
    expect(world.getId(-4, -1, -3)).toBe(mass);
    expect(world.getId(5, 2, 9)).toBe(mass);
    expect(world.getId(6, 2, 9)).toBe(EMPTY_ID);
    expect(world.fillBox(-4, -1, -3, 5, 2, 9, mass)).toBe(0);
    expect(world.fillBox(-4, -1, -3, 5, 2, 9, EMPTY_ID)).toBe(520);
    expect(world.cellCount).toBe(0);
    expect(world.chunkCount).toBe(0);
  });

  it("marks neighbours only where the box reaches a chunk boundary", () => {
    const world = new World({ chunkBits: 4 });
    const mass = world.states.intern({ semantic: "Mass" });
    world.fillBox(2, 2, 2, 13, 13, 13, mass);
    expect(world.takeDirtyChunks()).toEqual([chunkKey(0, 0, 0)]);
    world.fillBox(2, 2, 2, 15, 3, 3, mass);
    expect(world.takeDirtyChunks().sort()).toEqual([chunkKey(0, 0, 0), chunkKey(1, 0, 0)].sort());
  });
});

describe.each([3, 4, 5, MAX_CHUNK_BITS])("World with %i-bit chunks", (chunkBits) => {
  it("matches a plain map model under random sets and box fills", () => {
    const coord = fc.integer({ min: -40, max: 40 });
    const semantic = fc.constantFrom("Mass", "Trim", "Glow", null);
    const set = fc.record({
      kind: fc.constant("set" as const),
      x: coord,
      y: coord,
      z: coord,
      s: semantic,
    });
    const box = fc.record({
      kind: fc.constant("box" as const),
      a: fc.tuple(coord, coord, coord),
      size: fc.tuple(
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
      ),
      s: semantic,
    });
    fc.assert(
      fc.property(fc.array(fc.oneof(set, box), { maxLength: 60 }), (edits) => {
        const world = new World({ chunkBits });
        const model = new Map<string, string>();
        const apply = (x: number, y: number, z: number, s: string | null) => {
          if (s === null) model.delete(`${x},${y},${z}`);
          else model.set(`${x},${y},${z}`, s);
        };
        for (const edit of edits) {
          if (edit.kind === "set") {
            world.set(edit.x, edit.y, edit.z, edit.s === null ? null : { semantic: edit.s });
            apply(edit.x, edit.y, edit.z, edit.s);
          } else {
            const [x0, y0, z0] = edit.a;
            const [w, h, d] = edit.size;
            const id = edit.s === null ? EMPTY_ID : world.states.intern({ semantic: edit.s });
            world.fillBox(x0, y0, z0, x0 + w, y0 + h, z0 + d, id);
            for (let x = x0; x <= x0 + w; x++)
              for (let y = y0; y <= y0 + h; y++)
                for (let z = z0; z <= z0 + d; z++) apply(x, y, z, edit.s);
          }
        }
        expect(world.cellCount).toBe(model.size);
        const seen = new Map<string, string>();
        world.forEachCell((x, y, z, id) => {
          seen.set(`${x},${y},${z}`, world.states.get(id)?.semantic ?? "");
        });
        expect(seen).toEqual(model);
        // Every stored chunk holds cells, and their counts add up to the world's.
        let chunkCells = 0;
        for (const key of world.chunkKeys()) {
          const count = world.chunk(...chunkKeyToCoords(key))?.count ?? 0;
          expect(count).toBeGreaterThan(0);
          chunkCells += count;
        }
        expect(chunkCells).toBe(world.cellCount);
      }),
      { numRuns: 60 },
    );
  });
});
