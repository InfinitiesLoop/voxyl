// Shaped parts as Minecraft tile entities. Ports of the Godot app's FmpParts.gd and
// AcParts.gd, which were confirmed against the real mods' source rather than guessed.
//
// ForgeMultipart (microblocks: covers, panels, slabs, hollow covers, strips, posts, pillars,
// nooks, corners, notches):
//   - every multipart tile saves with id "savedMultipart" (MultipartSaveLoad.scala);
//   - its "parts" list holds one compound per part: {id: the part type's registered name,
//     shape: (size << 4 | slot) as a byte, material: the block's registry name, with "_<meta>"
//     appended when the meta isn't 0} (Microblock.save, BlockMicroMaterial.materialKey);
//   - the world block is "ForgeMultipart:block" at metadata 0;
//   - slot numbers are PartMap's, which packages/shapes follows already, so face, hollow,
//     corner and edge slots are stored as they are. A centred post (slot 12 + axis group) is
//     its own part type, "mcr_post", with the axis group stored in the low nibble.
//
// ArchitectureCraft (roofs and slopes; one per cell):
//   - the world block is "ArchitectureCraft:shape" (or "ArchitectureCraft:shapeSE" for the
//     glowing variant), at metadata 0; the tile entity id is "gcewing.shape";
//   - "Shape" is the enum's explicit id (SHAPE_ID, gaps and all), not its ordinal;
//   - orientation is two bytes: "side" (the face the base sits on) and "turn", which is exactly
//     packages/shapes' slot = side * 4 + turn;
//   - the base material is a registry name ("BaseName") and metadata ("BaseData").

import { CENTER_SLOT, MICRO_SHAPES } from "@voxyl/shapes";
import { fmpMaterialKey, type McIdentity } from "./identity.ts";
import { type Compound, nbt } from "./nbt.ts";

export const FMP_WORLD_REGISTRY = "ForgeMultipart:block";
export const FMP_TILE_ID = "savedMultipart";
export const AC_WORLD_REGISTRY = "ArchitectureCraft:shape";
/** The glowing variant: a second block that always gives full light. Same tile entity. */
export const AC_GLOW_WORLD_REGISTRY = "ArchitectureCraft:shapeSE";
export const AC_TILE_ID = "gcewing.shape";

export const acWorldRegistry = (glow: boolean): string =>
  glow ? AC_GLOW_WORLD_REGISTRY : AC_WORLD_REGISTRY;

const FMP_PART_ID = { face: "mcr_face", hollow: "mcr_hllw", corner: "mcr_cnr" } as const;

/**
 * One microblock part's NBT, or null when the shape isn't a microblock or the slot is out of
 * range. The caller has already found the block's identity.
 */
export function fmpPartTag(shape: string, slot: number, material: McIdentity): Compound | null {
  const spec = MICRO_SHAPES[shape];
  if (!spec) return null;
  let id: string;
  let stored = slot;
  if (spec.family === "edge") {
    if (slot >= CENTER_SLOT) {
      id = "mcr_post";
      stored = slot - CENTER_SLOT;
    } else {
      id = "mcr_edge";
    }
  } else {
    id = FMP_PART_ID[spec.family];
  }
  return {
    id: nbt.string(id),
    shape: nbt.byte((spec.size << 4) | stored),
    material: nbt.string(fmpMaterialKey(material)),
  };
}

/** The multipart tile entity for a cell's parts, at a position in the schematic. */
export function fmpTile(x: number, y: number, z: number, parts: readonly Compound[]): Compound {
  return {
    id: nbt.string(FMP_TILE_ID),
    x: nbt.int(x),
    y: nbt.int(y),
    z: nbt.int(z),
    parts: nbt.list("compound", parts),
  };
}

/** Whether ForgeMultipart can't saw this material, so its microblocks may render without a texture. */
export function sawWarning(material: McIdentity, shape: string): boolean {
  return shape in MICRO_SHAPES && material.sawable === false;
}

// ArchShapes id -> ArchitectureCraft's own Shape.id (not the ordinal), transcribed from
// Shape.java's declaration. Shapes packages/shapes doesn't model yet are here too, so adding
// them there needs no change here.
export const AC_SHAPE_ID: Readonly<Record<string, number>> = {
  roof_tile: 0,
  roof_outer_corner: 1,
  roof_inner_corner: 2,
  roof_ridge: 3,
  roof_smart_ridge: 4,
  roof_valley: 5,
  roof_smart_valley: 6,
  roof_overhang: 7,
  roof_overhang_outer_corner: 8,
  roof_overhang_inner_corner: 9,
  cylinder: 10,
  cylinder_half: 11,
  cylinder_quarter: 12,
  cylinder_large_quarter: 13,
  anticylinder_large_quarter: 14,
  pillar: 15,
  post: 16,
  pole: 17,
  bevelled_outer_corner: 18,
  bevelled_inner_corner: 19,
  pillar_base: 20,
  doric_capital: 21,
  ionic_capital: 22,
  corinthian_capital: 23,
  doric_triglyph: 24,
  doric_triglyph_corner: 25,
  doric_metope: 26,
  architrave: 27,
  architrave_corner: 28,
  sphere_full: 33,
  sphere_half: 34,
  sphere_quarter: 35,
  sphere_eighth: 36,
  sphere_eighth_large: 37,
  sphere_eighth_large_rev: 38,
  roof_overhang_gable_lh: 40,
  roof_overhang_gable_rh: 41,
  roof_overhang_gable_end_lh: 42,
  roof_overhang_gable_end_rh: 43,
  roof_overhang_ridge: 44,
  roof_overhang_valley: 45,
  cornice_lh: 50,
  cornice_rh: 51,
  cornice_end_lh: 52,
  cornice_end_rh: 53,
  cornice_ridge: 54,
  cornice_valley: 55,
  cornice_bottom: 56,
  arch_d1: 61,
  arch_d2: 62,
  arch_d3_a: 63,
  arch_d3_b: 64,
  arch_d3_c: 65,
  arch_d4_a: 66,
  arch_d4_b: 67,
  arch_d4_c: 68,
  banister_plain_bottom: 70,
  banister_plain: 71,
  banister_plain_top: 72,
  balustrade_fancy: 73,
  balustrade_fancy_corner: 74,
  balustrade_fancy_with_newel: 75,
  balustrade_fancy_newel: 76,
  balustrade_plain: 77,
  balustrade_plain_outer_corner: 78,
  balustrade_plain_with_newel: 79,
  banister_plain_end: 80,
  banister_fancy_newel_tall: 81,
  balustrade_plain_inner_corner: 82,
  balustrade_plain_end: 83,
  banister_fancy_bottom: 84,
  banister_fancy: 85,
  banister_fancy_top: 86,
  banister_fancy_end: 87,
  banister_plain_inner_corner: 88,
  slab: 90,
  stairs: 91,
  stairs_outer_corner: 92,
  stairs_inner_corner: 93,
  slope_tile_a1: 94,
  slope_tile_a2: 95,
  slope_tile_b1: 96,
  slope_tile_b2: 97,
  slope_tile_b3: 98,
  slope_tile_c1: 99,
  slope_tile_c2: 100,
  slope_tile_c3: 101,
  slope_tile_c4: 102,
  angled_roof_ridge: 115,
  double_roof_tile: 116,
};

/** Banisters shift half a block toward the side clicked (AC's Banister.placementOffsetX). */
const OFFSET_SHAPES = new Set([
  "banister_plain_bottom",
  "banister_plain",
  "banister_plain_top",
  "banister_plain_end",
  "balustrade_plain_end",
  "banister_fancy_bottom",
  "banister_fancy",
  "banister_fancy_top",
  "banister_fancy_end",
]);

/** The TileShape tile entity for one architecture part, or null for a shape with no known id. */
export function acTile(
  x: number,
  y: number,
  z: number,
  shape: string,
  slot: number,
  material: McIdentity,
): Compound | null {
  const id = AC_SHAPE_ID[shape];
  if (id === undefined) return null;
  const out: Compound = {
    id: nbt.string(AC_TILE_ID),
    x: nbt.int(x),
    y: nbt.int(y),
    z: nbt.int(z),
    Shape: nbt.int(id),
    side: nbt.byte((slot % 24) >> 2),
    turn: nbt.byte(slot & 3),
    BaseName: nbt.string(material.registry),
    BaseData: nbt.int(material.meta ?? 0),
  };
  if (OFFSET_SHAPES.has(shape)) out.offsetX = nbt.byte(slot >= 24 ? -6 : 6);
  return out;
}
