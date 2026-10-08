// A block's Minecraft identity, the one place materials meet the export (CLAUDE.md principles
// 1 and 3): voxels hold semantics, a palette's look names a block, and only here, at export
// time, does that block become a registry name and a metadata value. Nothing in the cells or
// the semantics ever stores one. Port of the Godot app's McId.gd and SchematicaMeta.gd.
//
// An identity comes from, in order: the block's own `mc` field in its library (what the NEI
// roster import of Phase 5 will fill in for modded blocks), then BUILTIN below for the names
// the default set and a vanilla jar share. A block with neither has no confirmed identity and
// is left out of the export and reported, never guessed.

import { facingOf, type Rotation, upOf } from "@voxyl/core";

/** Which family of block states a block's rotation sets in its metadata. */
export type Orient =
  /** Fixed: the confirmed metadata is used as it is. */
  | ""
  /** Slabs: bit 3 is the upper half. */
  | "half"
  /** Stairs: bits 0-1 the way they climb, bit 2 upside down. */
  | "stairs"
  /** Logs: bits 2-3 the axis they lie along. */
  | "log_axis";

export interface McIdentity {
  /** Minecraft's registry name: "minecraft:stone", "Ztones:tile.korpBlock". */
  readonly registry: string;
  /** The metadata value alongside it. For a GregTech machine this can exceed 15. */
  readonly meta?: number;
  readonly orient?: Orient;
  /**
   * The block's numeric id in the game it was read from, when known. Used as the schematic's
   * local id when it fits a byte, so a reader that ignores the name tables stays right.
   */
  readonly legacyId?: number;
  /** False when ForgeMultipart's saw can't cut this block into microblocks (see microblocks.cfg). */
  readonly sawable?: boolean;
  /** True when the identity is a best reading rather than one confirmed against the game. */
  readonly assumed?: boolean;
}

/** Looks up a block reference ("library:block") and says what it is in Minecraft, or null. */
export type IdentityResolver = (blockRef: string) => McIdentity | null;

/** The ForgeMultipart microblock "material" string: the registry name, "_<meta>" when non-zero. */
export function fmpMaterialKey(id: McIdentity): string {
  const meta = id.meta ?? 0;
  return meta > 0 ? `${id.registry}_${meta}` : id.registry;
}

/** "registry" or "registry:meta", the way a material list shows it. */
export function identityText(id: McIdentity): string {
  const meta = id.meta ?? 0;
  return meta > 0 ? `${id.registry}:${meta}` : id.registry;
}

// --- Orientation: a cell's rotation as the block's metadata ---

// Stairs' facing in Minecraft's own order (0 east, 1 west, 2 south, 3 north).
function stairsFacing(front: readonly [number, number, number]): number {
  if (front[0] === 1) return 0;
  if (front[0] === -1) return 1;
  if (front[2] === 1) return 2;
  return 3;
}

/**
 * The metadata a whole block is written with: its confirmed value, adjusted for how the cell
 * is turned. A cell's rotation is "front" and "up" (core rotation.ts); slabs and stairs read
 * whether up points down, stairs also which way they face, logs which axis up lies along.
 */
export function finalMeta(id: McIdentity, rotation: Rotation): number {
  const base = id.meta ?? 0;
  switch (id.orient ?? "") {
    case "half":
      return (base & 0x7) | (upOf(rotation)[1] < 0 ? 8 : 0);
    case "stairs":
      return stairsFacing(facingOf(rotation)) | (upOf(rotation)[1] < 0 ? 4 : 0);
    case "log_axis": {
      const up = upOf(rotation);
      return (base & 0x3) | (up[0] !== 0 ? 4 : up[2] !== 0 ? 8 : 0);
    }
    default:
      return base;
  }
}

// --- Built-in identities ---

type Row = readonly [
  name: string,
  registry: string,
  meta: number,
  legacyId: number,
  orient?: Orient,
];

// Minecraft 1.7.10 vanilla (the version GregTech: New Horizons runs): flattened names a modern
// jar and the default set use, mapped to the registry names and metadata of the old game. Block
// ids are vanilla's fixed ones. Blocks 1.7.10 has no equivalent for are left out on purpose.
const VANILLA: readonly Row[] = [
  ["stone", "stone", 0, 1],
  ["cobblestone", "cobblestone", 0, 4],
  ["stone_bricks", "stonebrick", 0, 98],
  // Smooth stone is the double slab's metadata 8.
  ["smooth_stone", "double_stone_slab", 8, 43],
  ["bricks", "brick_block", 0, 45],
  ["oak_planks", "planks", 0, 5],
  ["spruce_planks", "planks", 1, 5],
  ["birch_planks", "planks", 2, 5],
  ["dark_oak_planks", "planks", 5, 5],
  ["sand", "sand", 0, 12],
  ["gravel", "gravel", 0, 13],
  ["dirt", "dirt", 0, 3],
  ["grass_block", "grass", 0, 2],
  ["iron_block", "iron_block", 0, 42],
  ["terracotta", "hardened_clay", 0, 172],
  ["glass", "glass", 0, 20],
  ["glass_pane", "glass_pane", 0, 102],
  ["glowstone", "glowstone", 0, 89],
  // Metadata 4 is "no decay": a leaf block that stays where it was built.
  ["oak_leaves", "leaves", 4, 18],
  ["oak_log", "log", 0, 17, "log_axis"],
  ["spruce_log", "log", 1, 17, "log_axis"],
  ["sandstone", "sandstone", 0, 24],
  ["quartz_block", "quartz_block", 0, 155],
  ["oak_fence", "fence", 0, 85],
  // Slabs: the stone slab's metadata picks the material; the cell's rotation picks the half.
  ["stone_slab", "stone_slab", 0, 44, "half"],
  ["smooth_stone_slab", "stone_slab", 0, 44, "half"],
  ["sandstone_slab", "stone_slab", 1, 44, "half"],
  ["cobblestone_slab", "stone_slab", 3, 44, "half"],
  ["brick_slab", "stone_slab", 4, 44, "half"],
  ["stone_brick_slab", "stone_slab", 5, 44, "half"],
  ["quartz_slab", "stone_slab", 7, 44, "half"],
  ["oak_slab", "wooden_slab", 0, 126, "half"],
  ["spruce_slab", "wooden_slab", 1, 126, "half"],
  // 1.7.10's "stone_stairs" are cobblestone stairs.
  ["stone_stairs", "stone_stairs", 0, 67, "stairs"],
  ["cobblestone_stairs", "stone_stairs", 0, 67, "stairs"],
  ["stone_brick_stairs", "stone_brick_stairs", 0, 109, "stairs"],
  ["brick_stairs", "brick_stairs", 0, 108, "stairs"],
  ["sandstone_stairs", "sandstone_stairs", 0, 128, "stairs"],
  ["quartz_stairs", "quartz_stairs", 0, 156, "stairs"],
  ["oak_stairs", "oak_stairs", 0, 53, "stairs"],
  ["spruce_stairs", "spruce_stairs", 0, 134, "stairs"],
];

// Vanilla has no concrete before 1.12. Et Futurum Requiem adds it to GTNH, with the colour as
// the metadata in wool order. Written from memory of that mod, not read from a game dump, so
// every use is reported as assumed until a NEI roster import confirms it.
const CONCRETE: readonly string[] = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
];

const BUILTIN = new Map<string, McIdentity>();
for (const [name, registry, meta, legacyId, orient] of VANILLA) {
  BUILTIN.set(name, {
    registry: `minecraft:${registry}`,
    meta,
    legacyId,
    ...(orient && { orient }),
  });
}
CONCRETE.forEach((color, meta) => {
  BUILTIN.set(`${color}_concrete`, { registry: "etfuturum:concrete", meta, assumed: true });
});

/** The libraries whose block names are Minecraft's own (the default set and a vanilla jar). */
const VANILLA_LIBRARIES = new Set(["voxyl", "minecraft"]);

/**
 * The identity of a block the default set or a vanilla jar names the way Minecraft does, or
 * null. Imported blocks of other mods carry their own `mc` field instead.
 */
export function builtinIdentity(blockRef: string): McIdentity | null {
  const colon = blockRef.indexOf(":");
  if (colon <= 0) return null;
  if (!VANILLA_LIBRARIES.has(blockRef.slice(0, colon))) return null;
  return BUILTIN.get(blockRef.slice(colon + 1)) ?? null;
}
