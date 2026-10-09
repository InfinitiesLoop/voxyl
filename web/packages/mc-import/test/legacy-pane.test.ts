import { placeBlock, variantRotation } from "@voxyl/blocks";
import { IDENTITY } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { paneModels } from "../src/legacy/pane-geometry.ts";

const { models, block } = paneModels("chisel/pane", "chisel/glass", "chisel/glass_top");

const pane = { color: "#ffffff", ...block };

/** What a pane draws in one connection state: model name (without the base key) and y turn. */
const drawn = (props: Record<string, string>) =>
  placeBlock(pane, IDENTITY, props).map((p) => {
    const turn = [0, 90, 180, 270].find(
      (y) => variantRotation({ model: "", y: y as 0 }) === p.rotation,
    );
    return `${p.model.replace("chisel/pane/", "")}@${turn}`;
  });

describe("paneModels", () => {
  it("builds the five models under the base key", () => {
    expect(Object.keys(models).sort()).toEqual([
      "chisel/pane/noside",
      "chisel/pane/noside_alt",
      "chisel/pane/post",
      "chisel/pane/side",
      "chisel/pane/side_alt",
    ]);
    // Every model the wiring names exists.
    for (const part of block.multipart ?? []) expect(models[part.apply.model]).toBeDefined();
  });

  it("keeps vanilla's boxes and uv rects, in sixteenths", () => {
    expect(models["chisel/pane/post"]?.elements).toEqual([
      {
        from: [7, 0, 7],
        to: [9, 16, 9],
        faces: {
          up: { texture: "chisel/glass_top", uv: [7, 7, 9, 9] },
          down: { texture: "chisel/glass_top", uv: [7, 7, 9, 9] },
        },
      },
    ]);
    expect(models["chisel/pane/side"]?.elements).toEqual([
      {
        from: [7, 0, 0],
        to: [9, 16, 7],
        faces: {
          north: { texture: "chisel/glass_top", uv: [7, 0, 9, 16], cullface: "north" },
          east: { texture: "chisel/glass", uv: [9, 0, 16, 16] },
          west: { texture: "chisel/glass", uv: [16, 0, 9, 16] },
          up: { texture: "chisel/glass_top", uv: [7, 0, 9, 7] },
          down: { texture: "chisel/glass_top", uv: [7, 0, 9, 7] },
        },
      },
    ]);
    expect(models["chisel/pane/side_alt"]?.elements).toEqual([
      {
        from: [7, 0, 9],
        to: [9, 16, 16],
        faces: {
          east: { texture: "chisel/glass", uv: [0, 0, 7, 16] },
          south: { texture: "chisel/glass_top", uv: [7, 0, 9, 16], cullface: "south" },
          west: { texture: "chisel/glass", uv: [7, 0, 0, 16] },
          up: { texture: "chisel/glass_top", uv: [7, 0, 9, 7] },
          down: { texture: "chisel/glass_top", uv: [7, 0, 9, 7] },
        },
      },
    ]);
    // The caps use the flat glass texture, not the rim.
    expect(models["chisel/pane/noside"]?.elements[0]?.faces).toEqual({
      north: { texture: "chisel/glass", uv: [9, 0, 7, 16] },
    });
    expect(models["chisel/pane/noside_alt"]?.elements[0]?.faces).toEqual({
      east: { texture: "chisel/glass", uv: [7, 0, 9, 16] },
    });
  });

  it("wires multipart cases the vanilla way", () => {
    expect(block.multipart).toEqual([
      { apply: { model: "chisel/pane/post" } },
      { when: { north: "true" }, apply: { model: "chisel/pane/side" } },
      { when: { east: "true" }, apply: { model: "chisel/pane/side", y: 90 } },
      { when: { south: "true" }, apply: { model: "chisel/pane/side_alt" } },
      { when: { west: "true" }, apply: { model: "chisel/pane/side_alt", y: 90 } },
      { when: { north: "false" }, apply: { model: "chisel/pane/noside" } },
      { when: { east: "false" }, apply: { model: "chisel/pane/noside_alt" } },
      { when: { south: "false" }, apply: { model: "chisel/pane/noside_alt", y: 90 } },
      { when: { west: "false" }, apply: { model: "chisel/pane/noside", y: 270 } },
    ]);
  });

  it("draws a post and four caps when isolated", () => {
    // Unset properties read "false": an isolated pane is capped on every side, each cap turned
    // to its own side.
    expect(drawn({})).toEqual([
      "post@0",
      "noside@0",
      "noside_alt@0",
      "noside_alt@90",
      "noside@270",
    ]);
  });

  it("draws an arm in place of a cap where a neighbour connects", () => {
    expect(drawn({ north: "true", east: "false", south: "true", west: "false" })).toEqual([
      "post@0",
      "side@0",
      "side_alt@0",
      "noside_alt@0",
      "noside@270",
    ]);
    expect(drawn({ north: "true", east: "true", south: "true", west: "true" })).toEqual([
      "post@0",
      "side@0",
      "side@90",
      "side_alt@0",
      "side_alt@90",
    ]);
  });
});
