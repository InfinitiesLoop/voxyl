import { World } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { CITY_SEMANTICS, generateCity } from "../src/index.ts";

/** An order-independent fingerprint of every cell's position and semantic. */
function fingerprint(world: World): number {
  let hash = 0;
  world.forEachCell((x, y, z, id) => {
    const semantic = world.states.get(id)?.semantic ?? "";
    let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    for (let i = 0; i < semantic.length; i++) h = Math.imul(h ^ semantic.charCodeAt(i), 16777619);
    hash = (hash + h) | 0;
  });
  return hash;
}

describe("generateCity", () => {
  it("is deterministic for a seed, whatever the chunk size", () => {
    const a = new World({ chunkBits: 5 });
    const b = new World({ chunkBits: 4 });
    generateCity(a, { targetCells: 60_000, seed: 7 });
    generateCity(b, { targetCells: 60_000, seed: 7 });
    expect(b.cellCount).toBe(a.cellCount);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it("varies with the seed", () => {
    const a = new World();
    const b = new World();
    generateCity(a, { targetCells: 60_000, seed: 1 });
    generateCity(b, { targetCells: 60_000, seed: 2 });
    expect(fingerprint(b)).not.toBe(fingerprint(a));
  });

  it("reaches the target without overshooting by more than a lot", () => {
    const world = new World();
    const stats = generateCity(world, { targetCells: 250_000 });
    expect(world.cellCount).toBeGreaterThanOrEqual(250_000);
    expect(world.cellCount).toBeLessThan(250_000 + 40_000);
    expect(stats.lots).toBeGreaterThan(1);
  });

  it("keeps every cell inside the reported bounds and uses only city semantics", () => {
    const world = new World();
    const { min, max } = generateCity(world, { targetCells: 80_000 });
    const semantics = new Set<string>(CITY_SEMANTICS);
    world.forEachCell((x, y, z, id) => {
      expect(
        x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2],
      ).toBe(true);
      expect(semantics.has(world.states.get(id)?.semantic ?? "")).toBe(true);
    });
  });
});
