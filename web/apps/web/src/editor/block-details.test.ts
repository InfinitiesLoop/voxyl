import { ROOT_PALETTE } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { newProject, paletteInfo, setLookCommand } from "../world/editing.ts";
import { blockDetail } from "./block-details.ts";

describe("block details", () => {
  it("names the semantic, the block it is assigned, and glow", () => {
    const project = newProject("Test", 4);
    const palettes = paletteInfo(project);
    const wall = project.semantics.byName("Wall") as number;
    const light = project.semantics.byName("Light") as number;
    expect(blockDetail(palettes, wall)).toEqual({
      name: "Wall",
      palette: "Main",
      block: "White concrete",
      library: "Voxyl defaults",
      blockRef: "voxyl:white_concrete",
      color: "#d9d4c7",
      glow: false,
    });
    expect(blockDetail(palettes, light)).toEqual({
      name: "Light",
      palette: "Main",
      block: "Glowstone",
      library: "Voxyl defaults",
      blockRef: "voxyl:glowstone",
      color: "#ffd36b",
      glow: true,
    });
  });

  it("says undecided when the look names no block, and nothing for an unknown id", () => {
    const project = newProject("Test", 4);
    const wall = project.semantics.byName("Wall") as number;
    project.run(setLookCommand(project, wall, { tint: "#d9d4c7" }) as never);
    expect(blockDetail(paletteInfo(project), wall)).toEqual({
      name: "Wall",
      palette: "Main",
      block: null,
      library: null,
      color: "#d9d4c7",
      glow: false,
    });
    expect(blockDetail(paletteInfo(project), 9999)).toBeNull();
  });

  it("names the block library a look resolves to", () => {
    const project = newProject("Test", 4);
    const wall = project.semantics.byName("Wall") as number;
    project.run(setLookCommand(project, wall, { block: "minecraft:stone" }) as never);
    const palettes = paletteInfo(project);
    expect(blockDetail(palettes, wall)).toMatchObject({ block: "Stone", library: "minecraft" });
    expect(blockDetail(palettes, wall, [{ id: "minecraft", name: "Minecraft" }])?.library).toBe(
      "Minecraft",
    );
  });

  it("names the palette the semantic resolves in, including one derived into a child", () => {
    const project = newProject("Test", 4);
    const child = project.semantics.addPalette("Walkway", { extends: ROOT_PALETTE });
    const derived = project.semantics.derive(child, project.semantics.byName("Wall") as number);
    expect(blockDetail(paletteInfo(project), derived)).toMatchObject({
      name: "Wall",
      palette: "Walkway",
      block: "White concrete",
    });
  });
});
