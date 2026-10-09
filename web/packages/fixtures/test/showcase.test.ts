import { defaultLibrary } from "@voxyl/blocks";
import { Project } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { buildShowcase } from "../src/showcase.ts";

function named(project: Project, name: string, minY = 0): number {
  const { world, semantics } = project;
  let count = 0;
  world.forEachCell((_x, y, _z, id) => {
    if (y < minY) return;
    const semantic = world.states.get(id)?.semantic;
    if (semantic !== undefined && semantics.nameOf(semantic) === name) count++;
  });
  return count;
}

describe("buildShowcase", () => {
  it("puts a court in front of the catalogue", () => {
    const project = new Project();
    const { max } = buildShowcase(project, defaultLibrary());
    // The tower's roof and the trees stand above the one-block catalogue.
    expect(max[1]).toBeGreaterThanOrEqual(8);
    expect(named(project, "oak_leaves", 5)).toBeGreaterThan(0);
    expect(named(project, "glass", 2)).toBeGreaterThan(0);
    expect(named(project, "glowstone", 2)).toBeGreaterThan(0);
    expect(named(project, "oak_fence")).toBeGreaterThan(0);
    // Every block in the library is placed at least once.
    for (const name of Object.keys(defaultLibrary().blocks)) {
      expect(named(project, name), name).toBeGreaterThan(0);
    }
  });
});
