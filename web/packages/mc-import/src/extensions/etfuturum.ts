// EtFuturum restores several post-1.7.10 vanilla block families into GTNH, each as ONE registry
// name with 16 packed metas (mirroring vanilla's own metadata scheme), but ships every meta's
// texture as its own colour-PREFIXED file (gray_concrete.png, white_concrete.png) rather than
// the base-name-then-suffix shape the roster import's meta matching looks for (concrete_7.png:
// the registry's own token has to come first). So every meta of etfuturum:concrete and
// concrete_powder fails to match and the whole 32-block family is silently dropped. This binds
// each meta straight to its own file by colour name. The colour order is vanilla's own dye/wool
// metadata order, confirmed against the pack's real NEI dump.

import type { McSide } from "@voxyl/blocks";
import type { HealContext } from "../legacy/heal.ts";

/** Vanilla's dye and wool metadata order, which every colour-packed registry follows. */
export const DYE_COLORS: readonly string[] = [
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

/** "light_blue" to "Light Blue". */
export function colorTitle(color: string): string {
  return color
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** One texture on all six sides. */
export function allSides(key: string): Record<McSide, string> {
  return { up: key, down: key, north: key, south: key, east: key, west: key };
}

export async function healEtfuturum(ctx: HealContext): Promise<void> {
  await healColorPacked(ctx, "etfuturum:concrete", "{}_concrete", "{} Concrete");
  await healColorPacked(
    ctx,
    "etfuturum:concrete_powder",
    "{}_concrete_powder",
    "{} Concrete Powder",
  );
}

/**
 * A meta-packed registry whose 16 dye-ordered variants each have their own colour-prefixed
 * texture file under vanilla's shared "minecraft" domain: one confirmed, uniformly textured cube
 * per meta. `{}` in the formats stands for the colour; reusable for any other EtFuturum family
 * shaped the same way.
 */
async function healColorPacked(
  ctx: HealContext,
  registry: string,
  fileFormat: string,
  displayFormat: string,
): Promise<void> {
  for (const [meta, color] of DYE_COLORS.entries()) {
    const ref = `minecraft:blocks/${fileFormat.replace("{}", color)}`;
    if (!ctx.sourceHasTexture(ref)) continue;
    const key = await ctx.ensureTexture(ref);
    if (key === null) continue;
    const display = displayFormat.replace("{}", colorTitle(color));
    const name = ctx.existingFor(registry, meta) ?? ctx.uniqueName(display);
    if (ctx.addCube(name, allSides(key), { color: ctx.averageColor(key) })) {
      ctx.confirmRegistry(name, { registry, meta });
    }
  }
}
