// Extra Utilities' "Lapis Caelestis" (registry ExtraUtilities:greenscreen, meta 0-15): a flat,
// borderless solid-colour block and a real light source (its BlockGreenScreen takes the average
// of its own RGB x 15, so white or cyan glows near max and black or brown barely at all). The
// jar holds one effectively blank texture (a tiny near-white 16x16 greenscreen.png) recoloured
// per meta purely in Java, with no blockstate/model, so nothing generic could find 16 variants
// from one file. Synthesised here as 16 solid-colour textures instead of reading the art at all:
// tinting the blank would give the same result, but this doesn't depend on it staying blank.
// Colours and Latin/English names come from the mod's source (the `cols` array) cross-checked
// against the pack's own NEI item panel names.

import type { HealContext } from "../legacy/heal.ts";
import { allSides } from "./etfuturum.ts";

const LAPIS_REGISTRY = "ExtraUtilities:greenscreen";

/** meta -> display name and RGB. */
const LAPIS_COLORS: readonly (readonly [name: string, rgb: number])[] = [
  ["Lapis Caelestis Albus (White)", 0xffffff],
  ["Lapis Caelestis Aurantiacus (Orange)", 0xff8000],
  ["Lapis Caelestis Purpura Amethystinus (Magenta)", 0xff00ff],
  ["Lapis Caelestis Caesicius (Light Blue)", 0x007edd],
  ["Lapis Caelestis Flavus (Yellow)", 0xffff00],
  ["Lapis Caelestis Viridis (Green)", 0x00ff00],
  ["Lapis Caelestis Roseus (Pink)", 0xff99a6],
  ["Lapis Caelestis Cinereus (Gray)", 0x7f7f7f],
  ["Lapis Caelestis Lux Cinereus (Light Gray)", 0xd3d3d3],
  ["Lapis Caelestis Callainus (Cyan)", 0x00ffff],
  ["Lapis Caelestis Purpura (Purple)", 0xab33ff],
  ["Lapis Caelestis Caeruleus (Blue)", 0x0000ff],
  ["Lapis Caelestis Fuscus (Brown)", 0x2a3300],
  ["Lapis Caelestis Paphiae Myrti (Dark Green)", 0x009900],
  ["Lapis Caelestis Rufus (Red)", 0xff0000],
  ["Lapis Caelestis Nox (Black)", 0x000000],
];

export async function healExtraUtils(ctx: HealContext): Promise<void> {
  for (const [meta, [display, rgb]] of LAPIS_COLORS.entries()) {
    const color = `#${rgb.toString(16).padStart(6, "0")}`;
    const key = ctx.solidTexture(`extrautils:heal/greenscreen_${meta}`, color);
    const name = ctx.existingFor(LAPIS_REGISTRY, meta) ?? ctx.uniqueName(display);
    if (ctx.addCube(name, allSides(key), { color })) {
      ctx.confirmRegistry(name, { registry: LAPIS_REGISTRY, meta });
    }
  }
}
