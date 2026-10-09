// GregTech's tables: the voltage tiers, where its textures live, and the folder names the lang
// file spells differently. Data only; the healer that reads them is gregtech.ts.

/** Texture-ref prefixes in the "<ns>:<path>" key convention (no `textures/`, no `.png`). */
export const ICONSETS = "gregtech:blocks/iconsets";
export const BASICMACHINES = "gregtech:blocks/basicmachines";

/** Where the machine overlays sit in the asset tree, for listing the machine folders. */
export const MACHINES_TEX_DIR = "gregtech/textures/blocks/basicmachines";

/**
 * Voltage tiers a basic machine spans, `tier.01` first (GT5 basic machines start at LV). The case
 * matches the texture file names: MACHINE_LuV_SIDE is mixed-case, not MACHINE_LUV_SIDE.
 */
export const MACHINE_TIERS: readonly string[] = [
  "LV",
  "MV",
  "HV",
  "EV",
  "IV",
  "LuV",
  "ZPM",
  "UV",
  "UHV",
  "UEV",
  "UIV",
  "UMV",
];

/** Tier casings also include ULV (`gt.blockcasings.0.name` = ULV Machine Casing). */
export const CASING_TIERS: readonly string[] = [
  "ULV",
  "LV",
  "MV",
  "HV",
  "EV",
  "IV",
  "LuV",
  "ZPM",
  "UV",
  "UHV",
  "UEV",
  "UIV",
];

/**
 * Texture folder to GregTech.lang machine key, for the few that don't match once underscores are
 * stripped (the lang abbreviates "electric" to "e"). Everything else matches that way
 * (alloy_smelter and alloysmelter).
 */
export const FOLDER_ALIAS: Readonly<Record<string, string>> = {
  electric_furnace: "e_furnace",
  electric_oven: "e_oven",
};
