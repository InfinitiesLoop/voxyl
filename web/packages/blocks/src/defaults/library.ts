// The default block set ("voxyl:..."): original textures (textures.ts) on models and
// blockstates written the way Minecraft writes them, so the default set and imported jars take
// one path through the renderer. A first pass at the basic building blocks; add more freely.

import type { Block, Element, Face, Library, McSide, Model, Texture, Variant } from "../library.ts";
import { DEFAULT_TEXTURE_KEYS, paintTexture } from "./textures.ts";

export const DEFAULT_LIBRARY_ID = "voxyl";

const SIDES: readonly McSide[] = ["down", "up", "north", "south", "west", "east"];

type Faces = Partial<Record<McSide, Face>>;

function box(from: [number, number, number], to: [number, number, number], faces: Faces): Element {
  return { from, to, faces };
}

/** Every side of a full-cell element, culled against its neighbour. */
function allSides(texture: (side: McSide) => string): Faces {
  const faces: Faces = {};
  for (const side of SIDES) faces[side] = { texture: texture(side), cullface: side };
  return faces;
}

const cubeAll = (t: string): Model => ({
  elements: [
    box(
      [0, 0, 0],
      [16, 16, 16],
      allSides(() => t),
    ),
  ],
});

const cubeColumn = (side: string, end: string): Model => ({
  elements: [
    box(
      [0, 0, 0],
      [16, 16, 16],
      allSides((s) => (s === "up" || s === "down" ? end : side)),
    ),
  ],
});

const cubeBottomTop = (side: string, top: string, bottom: string): Model => ({
  elements: [
    box(
      [0, 0, 0],
      [16, 16, 16],
      allSides((s) => (s === "up" ? top : s === "down" ? bottom : side)),
    ),
  ],
});

interface Skin {
  readonly top: string;
  readonly bottom: string;
  readonly side: string;
}

const slab = ({ top, bottom, side }: Skin): Model => ({
  elements: [
    box([0, 0, 0], [16, 8, 16], {
      down: { texture: bottom, cullface: "down" },
      up: { texture: top },
      north: { texture: side, cullface: "north" },
      south: { texture: side, cullface: "south" },
      west: { texture: side, cullface: "west" },
      east: { texture: side, cullface: "east" },
    }),
  ],
});

const slabTop = ({ top, bottom, side }: Skin): Model => ({
  elements: [
    box([0, 8, 0], [16, 16, 16], {
      down: { texture: bottom },
      up: { texture: top, cullface: "up" },
      north: { texture: side, cullface: "north" },
      south: { texture: side, cullface: "south" },
      west: { texture: side, cullface: "west" },
      east: { texture: side, cullface: "east" },
    }),
  ],
});

/** Minecraft's straight stairs: a bottom slab and a raised back half on the east. */
const stairs = ({ top, bottom, side }: Skin): Model => ({
  elements: [
    box([0, 0, 0], [16, 8, 16], {
      down: { texture: bottom, cullface: "down" },
      up: { texture: top },
      north: { texture: side, cullface: "north" },
      south: { texture: side, cullface: "south" },
      west: { texture: side, cullface: "west" },
      east: { texture: side, cullface: "east" },
    }),
    box([8, 8, 0], [16, 16, 16], {
      up: { texture: top, cullface: "up" },
      north: { texture: side, cullface: "north" },
      south: { texture: side, cullface: "south" },
      west: { texture: side },
      east: { texture: side, cullface: "east" },
    }),
  ],
});

const fencePost = (t: string): Model => ({
  elements: [
    box([6, 0, 6], [10, 16, 10], {
      down: { texture: t, cullface: "down" },
      up: { texture: t, cullface: "up" },
      north: { texture: t },
      south: { texture: t },
      west: { texture: t },
      east: { texture: t },
    }),
  ],
});

/** Two rails from the post out to the north edge. */
const fenceSide = (t: string): Model => {
  const rail = (y0: number, y1: number) =>
    box([7, y0, 0], [9, y1, 9], {
      down: { texture: t },
      up: { texture: t },
      north: { texture: t, cullface: "north" },
      west: { texture: t },
      east: { texture: t },
    });
  return { elements: [rail(12, 15), rail(6, 9)] };
};

const panePost = (edge: string): Model => ({
  elements: [
    box([7, 0, 7], [9, 16, 9], {
      down: { texture: edge, cullface: "down" },
      up: { texture: edge, cullface: "up" },
      north: { texture: edge },
      south: { texture: edge },
      west: { texture: edge },
      east: { texture: edge },
    }),
  ],
});

/** The pane from its post out to the north edge. */
const paneSide = (glass: string, edge: string): Model => ({
  elements: [
    box([7, 0, 0], [9, 16, 7], {
      down: { texture: edge, cullface: "down" },
      up: { texture: edge, cullface: "up" },
      north: { texture: edge, cullface: "north" },
      west: { texture: glass },
      east: { texture: glass },
    }),
  ],
});

const one = (model: string): Block["variants"] => ({ "": { model } });

const column = (model: string): Block["variants"] => ({
  "axis=y": { model },
  "axis=z": { model, x: 90 },
  "axis=x": { model, x: 90, y: 90 },
});

const slabStates = (bottom: string, top: string, full: string): Block["variants"] => ({
  "type=bottom": { model: bottom },
  "type=top": { model: top },
  "type=double": { model: full },
});

function stairStates(model: string): Block["variants"] {
  const out: Record<string, Variant> = {};
  const turns = { east: 0, south: 90, west: 180, north: 270 } as const;
  for (const [facing, y] of Object.entries(turns))
    for (const half of ["bottom", "top"] as const) {
      const key = `facing=${facing},half=${half},shape=straight`;
      out[key] =
        half === "bottom" ? { model, y, uvlock: y !== 0 } : { model, x: 180, y, uvlock: true };
    }
  return out;
}

function connected(post: string, side: string): NonNullable<Block["multipart"]> {
  const turns = { north: 0, east: 90, south: 180, west: 270 } as const;
  return [
    { apply: { model: post } },
    ...Object.entries(turns).map(([dir, y]) => ({
      when: { [dir]: "true" },
      apply: { model: side, y, uvlock: true } satisfies Variant,
    })),
  ];
}

/** Builds the default library. Textures are painted on first use of the library. */
export function buildDefaultLibrary(): Library {
  const textures: Record<string, Texture> = {};
  for (const key of DEFAULT_TEXTURE_KEYS) textures[key] = paintTexture(key);
  const colorOf = (t: string) => textures[t]?.color ?? "#808080";
  const models: Record<string, Model> = {};
  const blocks: Record<string, Block> = {};

  const cube = (name: string, texture = name, extra: Partial<Block> = {}) => {
    models[name] = cubeAll(texture);
    blocks[name] = { variants: one(name), color: colorOf(texture), ...extra };
  };
  for (const name of [
    "stone",
    "cobblestone",
    "stone_bricks",
    "smooth_stone",
    "bricks",
    "oak_planks",
    "spruce_planks",
    "birch_planks",
    "dark_oak_planks",
    "sand",
    "gravel",
    "dirt",
    "iron_block",
    "terracotta",
    "white_concrete",
    "light_gray_concrete",
    "gray_concrete",
    "black_concrete",
    "cyan_concrete",
    "blue_concrete",
    "red_concrete",
    "yellow_concrete",
  ])
    cube(name);
  cube("glass", "glass", { transparent: true });
  cube("glowstone", "glowstone", { emits: 15 });
  cube("oak_leaves", "oak_leaves", { transparent: true });

  for (const wood of ["oak", "spruce"]) {
    const name = `${wood}_log`;
    models[name] = cubeColumn(name, `${name}_top`);
    blocks[name] = { variants: column(name), color: colorOf(name) };
  }
  models.grass_block = cubeBottomTop("grass_block_side", "grass_block_top", "dirt");
  blocks.grass_block = { variants: one("grass_block"), color: colorOf("grass_block_top") };
  models.sandstone = cubeBottomTop("sandstone", "sandstone_top", "sandstone_bottom");
  blocks.sandstone = { variants: one("sandstone"), color: colorOf("sandstone") };
  models.quartz_block = cubeColumn("quartz_block_side", "quartz_block_top");
  blocks.quartz_block = { variants: one("quartz_block"), color: colorOf("quartz_block_side") };

  // Slabs and stairs: [prefix, skin, the full block a double slab shows].
  const shaped: [string, Skin, string][] = [
    ["stone", { top: "stone", bottom: "stone", side: "stone" }, "stone"],
    [
      "smooth_stone",
      { top: "smooth_stone", bottom: "smooth_stone", side: "smooth_stone" },
      "smooth_stone",
    ],
    [
      "cobblestone",
      { top: "cobblestone", bottom: "cobblestone", side: "cobblestone" },
      "cobblestone",
    ],
    [
      "stone_brick",
      { top: "stone_bricks", bottom: "stone_bricks", side: "stone_bricks" },
      "stone_bricks",
    ],
    ["brick", { top: "bricks", bottom: "bricks", side: "bricks" }, "bricks"],
    ["oak", { top: "oak_planks", bottom: "oak_planks", side: "oak_planks" }, "oak_planks"],
    [
      "spruce",
      { top: "spruce_planks", bottom: "spruce_planks", side: "spruce_planks" },
      "spruce_planks",
    ],
    [
      "sandstone",
      { top: "sandstone_top", bottom: "sandstone_bottom", side: "sandstone" },
      "sandstone",
    ],
    [
      "quartz",
      { top: "quartz_block_top", bottom: "quartz_block_top", side: "quartz_block_side" },
      "quartz_block",
    ],
  ];
  for (const [prefix, skin, full] of shaped) {
    const color = colorOf(skin.side);
    models[`${prefix}_slab`] = slab(skin);
    models[`${prefix}_slab_top`] = slabTop(skin);
    blocks[`${prefix}_slab`] = {
      variants: slabStates(`${prefix}_slab`, `${prefix}_slab_top`, full),
      transparent: true,
      color,
    };
    if (prefix === "smooth_stone") continue; // Minecraft has no smooth stone stairs
    models[`${prefix}_stairs`] = stairs(skin);
    blocks[`${prefix}_stairs`] = {
      variants: stairStates(`${prefix}_stairs`),
      transparent: true,
      color,
    };
  }

  for (const wood of ["oak", "spruce"]) {
    const planks = `${wood}_planks`;
    models[`${wood}_fence_post`] = fencePost(planks);
    models[`${wood}_fence_side`] = fenceSide(planks);
    blocks[`${wood}_fence`] = {
      multipart: connected(`${wood}_fence_post`, `${wood}_fence_side`),
      transparent: true,
      color: colorOf(planks),
    };
  }
  models.glass_pane_post = panePost("glass_pane_top");
  models.glass_pane_side = paneSide("glass", "glass_pane_top");
  blocks.glass_pane = {
    multipart: connected("glass_pane_post", "glass_pane_side"),
    transparent: true,
    color: colorOf("glass"),
  };

  return { id: DEFAULT_LIBRARY_ID, name: "Voxyl defaults", blocks, models, textures };
}

let shared: Library | null = null;

/** The default library, built once. */
export function defaultLibrary(): Library {
  shared ??= buildDefaultLibrary();
  return shared;
}
