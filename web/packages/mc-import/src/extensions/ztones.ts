// Gives Ztones' "Flat Lamp" trio (registries lampf, lampt, lampb) a default LOOK closer to what
// they are. None of the three is a full block: collision is null, neither opaque nor a normal
// block, and the bounds are one of six 0.1-thick plates flush against whichever face the block
// is placed on (a wall, ceiling or floor fixture). The roster import can't know that and draws a
// full cube, which is what the library browser showed outside any palette. This only replaces
// the block's own DEFAULT model with the ceiling-mounted case (the most recognisable of the six
// as "a light fixture"): never a substitute for the palette's own Cover shape, which is still how
// a real placement picks its face and makes its own geometry.
//
// Deliberately NOT renamed: the three share Ztones' single "Flat Lamp" name, but that is a
// per-project palette/semantic naming choice, not something to bake into the shared library.

import type { HealContext } from "../legacy/heal.ts";
import { allSides } from "./etfuturum.ts";

const LAMPS = ["lampf", "lampt", "lampb"];

/** The ceiling case of BlockLampFlat's setBlockBounds: a 0.1-thick plate on the top face. */
const LAMP_FROM = [0, 14.4, 0] as const;
const LAMP_TO = [16, 16, 16] as const;

export async function healZtones(ctx: HealContext): Promise<void> {
  for (const reg of LAMPS) {
    const found = ctx.draft.findByIdentity(`Ztones:${reg}`, 0);
    if (!found) continue;
    const key = ctx.blockTextureKeys(found.name)[0];
    if (key === undefined) continue;
    ctx.addCube(found.name, allSides(key), {
      color: found.block.color,
      from: LAMP_FROM,
      to: LAMP_TO,
    });
  }
}
