// The palettes every browser starts with in its shared palettes: a few plain looks made of the
// default block set ("voxyl:..."), so there is something to play with before any is made. They
// are ordinary shared palettes once stored: a project links one, extends it, or ignores it, and
// they can be deleted from Home. Only the semantics' names are the same across them, so
// swapping one for another re-skins a build, which is the point of keeping blocks in palettes.

import type { SharedPalette } from "@voxyl/core";

type Entry = { name: string; description: string; block: string; tint: string; glow?: true };

function palette(key: string, name: string, description: string, entries: Entry[]) {
  return {
    key,
    name,
    description,
    semantics: entries.map((e) => ({
      key: e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: e.name,
      description: e.description,
      look: { block: e.block, tint: e.tint, ...(e.glow && { glow: true }) },
    })),
  } satisfies Omit<SharedPalette, "version">;
}

export const DEFAULT_PALETTES: readonly Omit<SharedPalette, "version">[] = [
  palette(
    "voxyl.stone-brick",
    "Stone and brick",
    "Masonry: stone below, brick walls, quartz trim",
    [
      {
        name: "Foundation",
        description: "What the build stands on",
        block: "voxyl:stone_bricks",
        tint: "#7b7b7b",
      },
      { name: "Wall", description: "The main walls", block: "voxyl:bricks", tint: "#9a553a" },
      {
        name: "Floor",
        description: "Floors and paving",
        block: "voxyl:smooth_stone",
        tint: "#9a9a9a",
      },
      {
        name: "Roof",
        description: "Roofs and the tops of things",
        block: "voxyl:cobblestone",
        tint: "#6b6b6b",
      },
      {
        name: "Trim",
        description: "Edges, sills and bands",
        block: "voxyl:quartz_block",
        tint: "#e9e3da",
      },
      { name: "Window", description: "Windows and glazing", block: "voxyl:glass", tint: "#c9e3e8" },
      {
        name: "Light",
        description: "Light sources",
        block: "voxyl:glowstone",
        tint: "#ffd27a",
        glow: true,
      },
    ],
  ),
  palette("voxyl.timber", "Timber", "Warm woods: logs for the frame, planks for the rest", [
    { name: "Frame", description: "Posts and beams", block: "voxyl:oak_log", tint: "#6b4f3a" },
    { name: "Wall", description: "The main walls", block: "voxyl:birch_planks", tint: "#c8b77a" },
    { name: "Floor", description: "Floors and decks", block: "voxyl:oak_planks", tint: "#9a7b5a" },
    {
      name: "Roof",
      description: "Roofs and the tops of things",
      block: "voxyl:dark_oak_planks",
      tint: "#4a3623",
    },
    {
      name: "Trim",
      description: "Edges, rails and fences",
      block: "voxyl:spruce_planks",
      tint: "#6f5334",
    },
    {
      name: "Window",
      description: "Windows and glazing",
      block: "voxyl:glass_pane",
      tint: "#c9e3e8",
    },
    {
      name: "Light",
      description: "Light sources",
      block: "voxyl:glowstone",
      tint: "#ffd27a",
      glow: true,
    },
  ]),
  palette("voxyl.concrete", "Concrete", "Clean modern colours, with cyan to stand out", [
    {
      name: "Foundation",
      description: "What the build stands on",
      block: "voxyl:gray_concrete",
      tint: "#4d5157",
    },
    { name: "Wall", description: "The main walls", block: "voxyl:white_concrete", tint: "#d9d4c7" },
    {
      name: "Floor",
      description: "Floors and paving",
      block: "voxyl:light_gray_concrete",
      tint: "#8d8f94",
    },
    {
      name: "Roof",
      description: "Roofs and the tops of things",
      block: "voxyl:black_concrete",
      tint: "#1d1e22",
    },
    { name: "Trim", description: "Edges and bands", block: "voxyl:iron_block", tint: "#d8d8d8" },
    {
      name: "Accent",
      description: "A few standout details",
      block: "voxyl:cyan_concrete",
      tint: "#22b8cf",
    },
    { name: "Window", description: "Windows and glazing", block: "voxyl:glass", tint: "#a9d8e8" },
    {
      name: "Light",
      description: "Light sources",
      block: "voxyl:glowstone",
      tint: "#ffd27a",
      glow: true,
    },
  ]),
  palette("voxyl.landscape", "Landscape", "Ground, paths and growing things", [
    {
      name: "Grass",
      description: "Lawns and the top of the ground",
      block: "voxyl:grass_block",
      tint: "#689c3b",
    },
    { name: "Soil", description: "Under the grass", block: "voxyl:dirt", tint: "#7a5a3a" },
    { name: "Stone", description: "Rock and cliffs", block: "voxyl:stone", tint: "#7d7d7d" },
    { name: "Sand", description: "Beaches and dry ground", block: "voxyl:sand", tint: "#dbd0a0" },
    { name: "Gravel", description: "Paths and drives", block: "voxyl:gravel", tint: "#8a8583" },
    {
      name: "Foliage",
      description: "Leaves and hedges",
      block: "voxyl:oak_leaves",
      tint: "#4a7a2a",
    },
    { name: "Trunk", description: "Tree trunks", block: "voxyl:oak_log", tint: "#6b4f3a" },
  ]),
];
