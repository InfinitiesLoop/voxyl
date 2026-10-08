import { Project } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { CITY_SEMANTICS, CITY_THEMES, generateCity, prepareCityProject } from "../src/index.ts";

/** An order-independent fingerprint of every cell's position and semantic name. */
function fingerprint(project: Project): number {
  const { world, semantics } = project;
  let hash = 0;
  world.forEachCell((x, y, z, id) => {
    const name = semantics.nameOf(world.states.get(id)?.semantic ?? 0);
    let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
    hash = (hash + h) | 0;
  });
  return hash;
}

describe("generateCity", () => {
  it("is deterministic for a seed, whatever the chunk size", () => {
    const a = new Project({ chunkBits: 5 });
    const b = new Project({ chunkBits: 4 });
    generateCity(a, { targetCells: 60_000, seed: 7 });
    generateCity(b, { targetCells: 60_000, seed: 7 });
    expect(b.world.cellCount).toBe(a.world.cellCount);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it("varies with the seed", () => {
    const a = new Project();
    const b = new Project();
    generateCity(a, { targetCells: 60_000, seed: 1 });
    generateCity(b, { targetCells: 60_000, seed: 2 });
    expect(fingerprint(b)).not.toBe(fingerprint(a));
  });

  it("reaches the target without overshooting by more than a lot", () => {
    const project = new Project();
    const stats = generateCity(project, { targetCells: 250_000 });
    expect(project.world.cellCount).toBeGreaterThanOrEqual(250_000);
    expect(project.world.cellCount).toBeLessThan(250_000 + 40_000);
    expect(stats.lots).toBeGreaterThan(1);
  });

  it("keeps every cell inside the reported bounds and uses only city semantics", () => {
    const project = new Project();
    const { world, semantics } = project;
    const { min, max } = generateCity(project, { targetCells: 80_000 });
    const names = new Set<string>(CITY_SEMANTICS);
    world.forEachCell((x, y, z, id) => {
      expect(
        x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2],
      ).toBe(true);
      expect(names.has(semantics.nameOf(world.states.get(id)?.semantic ?? 0))).toBe(true);
    });
  });
});

describe("generateCity with parts", () => {
  it("gives every shaped part a semantic that places its shape, with the look of its block", () => {
    const project = new Project();
    prepareCityProject(project, CITY_THEMES[0] as never, true);
    generateCity(project, { targetCells: 80_000, parts: true });
    const { world, semantics } = project;
    const seen = new Set<string>();
    world.forEachCell((_x, _y, _z, id) => {
      for (const part of world.states.get(id)?.parts ?? []) {
        const resolved = semantics.resolve(part.semantic);
        expect(resolved.form.shape).toBe(part.shape);
        seen.add(resolved.name);
      }
    });
    expect(seen.size).toBeGreaterThan(3);
    const tile = semantics.byName("Roof Tile");
    const roof = semantics.byName("Roof", 1);
    expect(tile).toBeDefined();
    expect(semantics.resolve(tile as number).look.tint).toBe(
      semantics.resolve(roof as number).look.tint,
    );
  });
});
