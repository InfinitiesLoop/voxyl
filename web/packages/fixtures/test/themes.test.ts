import { defaultLibrary } from "@voxyl/blocks";
import { Project } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  CITY_SEMANTICS,
  CITY_THEMES,
  cityThemeOf,
  generateCity,
  prepareCityProject,
} from "../src/index.ts";

describe("the city themes", () => {
  const blocks = defaultLibrary().blocks;

  it("decide every semantic, and none but Minecraft's needs anything beyond the default set", () => {
    for (const theme of CITY_THEMES) {
      for (const name of CITY_SEMANTICS) {
        const ref = theme.looks[name]?.block ?? "";
        expect(ref, `${theme.name} ${name} is undecided`).not.toBe("");
        if (ref.startsWith("minecraft:")) continue;
        expect(ref.startsWith("voxyl:"), `${theme.name} ${name}: ${ref}`).toBe(true);
        expect(blocks[ref.slice("voxyl:".length)], `${theme.name} ${name}: ${ref}`).toBeDefined();
      }
    }
  });

  it("start a project on the first theme, with blocks", () => {
    const project = new Project({ chunkBits: 5 });
    prepareCityProject(project);
    generateCity(project, { targetCells: 5_000 });
    expect(cityThemeOf(project.semantics)).toBe(0);
    for (const name of CITY_SEMANTICS) {
      const id = project.semantics.byName(name) as number;
      expect(project.semantics.resolve(id).look.block, name).toMatch(/^voxyl:/);
    }
  });
});
