// Passes of the GTNH pack that apply across mods: the attachment flag for torch-like blocks, and
// the strip of GregTech-convention overlay textures that the plain import turned into blocks.

import type { HealContext } from "../legacy/heal.ts";

/**
 * Blocks that hold on to a neighbour the way a vanilla torch does (stand on the block below, or
 * lean out of a wall), whose textures are a torch in vanilla's layout but which the plain import
 * could only draw as a cube. Matched by registry name. Flagging one records `attachment` on the
 * block, and they all inherit vanilla's torch metadata from BlockTorch, which the schematic
 * export relies on. Add a mod's torch here once it is known to do the same. Magnum Torch is left
 * out on purpose: a chunky custom model, not a vanilla torch.
 */
const TORCHES: ReadonlySet<string> = new Set([
  "minecraft:torch",
  "minecraft:redstone_torch",
  "minecraft:unlit_redstone_torch",
  "etfuturum:soul_torch",
  "GalacticraftCore:tile.glowstoneTorch",
  "BloodArsenal:blood_torch",
]);

export function flagAttachments(ctx: HealContext): void {
  for (const [name, block] of Object.entries(ctx.draft.blocks)) {
    if (!block.attachment && block.mc && TORCHES.has(block.mc.registry)) {
      ctx.draft.addBlock(name, { ...block, attachment: "torch" });
    }
  }
}

/**
 * Deletes every roster block whose textures are all single-purpose GregTech overlays, never a
 * building block. Matched on the texture's file name, so independent of folder and namespace:
 *   `*_GLOW`                         emissive layer (BOILER_FRONT_GLOW, ...)
 *   `ARROW_*`, `PIPE_RESTRICTOR*`    pipe routing glyphs
 *   `*_SIGN`                         fluid and item I/O markers (FLUID_IN_SIGN, ...)
 *   `OVERLAY_SHUTTER*`, `OVERLAY_COVER*`, `COVER_*`, `ENDERFLUIDLINK_OVERLAY`   cover overlays
 * A block keeps its place if any texture isn't junk, so a real block that reuses one as an accent
 * survives. Healed blocks (model key `…:heal/…`) are never touched.
 */
export function stripOverlayJunk(ctx: HealContext): void {
  for (const name of Object.keys(ctx.draft.blocks)) {
    const models = ctx.blockModelKeys(name);
    if (models.some((m) => m.includes(":heal/"))) continue;
    const textures = ctx.blockTextureKeys(name);
    if (textures.length === 0) continue;
    if (textures.every((key) => isJunkLeaf(key.slice(key.lastIndexOf("/") + 1)))) {
      ctx.removeBlock(name);
    }
  }
}

export function isJunkLeaf(leaf: string): boolean {
  return (
    leaf.endsWith("_GLOW") ||
    leaf.startsWith("ARROW_") ||
    leaf.includes("PIPE_RESTRICTOR") ||
    leaf.endsWith("_SIGN") ||
    leaf.startsWith("OVERLAY_SHUTTER") ||
    leaf.startsWith("OVERLAY_COVER") ||
    leaf.startsWith("COVER_") ||
    leaf === "ENDERFLUIDLINK_OVERLAY"
  );
}
