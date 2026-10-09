// ProjectRed Illumination's "Lamp" block (registry projectred.illumination.lamp): 32 metas, 16
// vanilla-dye colours x off/on (0-15 = normal, lit only while powered; 16-31 = "Inverted", lit
// only while UNpowered; a real light source with a flat, textureless colour, unlike every ztones
// or concrete option). No blockstate/model JSON ships in this mod at all (1.7.10 pure-Java icon
// registration), so the roster import can never find these on its own: each colour+state is its
// own numbered file (textures/blocks/lighting/lampoff/<0-15>.png, lampon/<0-15>.png). Shown at
// its natural idle look: off for normal, on for inverted, as each would sit unpowered.
// ProjectRed's other Illumination blocks (lanterns, fixtures, cage lamps, buttons) use flat
// single-file textures with no per-colour art, so they are not modelled here.

import type { HealContext } from "../legacy/heal.ts";
import { allSides, colorTitle, DYE_COLORS } from "./etfuturum.ts";

const LAMP_REGISTRY = "ProjRed|Illumination:projectred.illumination.lamp";

export async function healProjRed(ctx: HealContext): Promise<void> {
  for (let meta = 0; meta < 32; meta++) {
    const inverted = meta >= 16;
    const colorIndex = inverted ? meta - 16 : meta;
    // The roster calls the mod "ProjRed|Illumination" but every ProjectRed module's art lives in
    // the one on-disk "projectred" namespace.
    const ref = `projectred:blocks/lighting/${inverted ? "lampon" : "lampoff"}/${colorIndex}`;
    if (!ctx.sourceHasTexture(ref)) continue;
    const key = await ctx.ensureTexture(ref);
    if (key === null) continue;
    const display = `${inverted ? "Inverted " : ""}${colorTitle(DYE_COLORS[colorIndex] ?? "")} Lamp`;
    const name = ctx.existingFor(LAMP_REGISTRY, meta) ?? ctx.uniqueName(display);
    if (ctx.addCube(name, allSides(key), { color: ctx.averageColor(key) })) {
      ctx.confirmRegistry(name, { registry: LAMP_REGISTRY, meta });
    }
  }
}
