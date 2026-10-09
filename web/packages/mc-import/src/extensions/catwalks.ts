// Catwalks: thin platform/rail/ladder blocks, critical to a GTNH build, whose per-item textures
// sit several state-folders deep (lit/tape/nobottom for the catwalk and caged-ladder families)
// that the roster import's suffix matching can't peel through. Of the pack's nine placeable
// roster rows for this mod only "Scaffold" survives unaided (its two files sit flat under
// textures/blocks/); this binds the rest by hand to their plain (unlit, untaped) textures.
//
// NOT a faithful reproduction of the mod's real non-cube geometry: rails, ladders and catwalks
// aren't cubes in-game and voxyl has no shape for them yet. Each gets a recognisable,
// correctly coloured, correctly export-identified cube stand-in, in the same spirit as the
// GregTech machine cubes; a real thin-platform/rail shape is future work.

import type { McSide } from "@voxyl/blocks";
import type { HealContext } from "../legacy/heal.ts";
import { allSides } from "./etfuturum.ts";

const TEXTURES = "catwalks:blocks";

type Faces = Readonly<Record<McSide, string>>;

/** The top and bottom differ, the four sides share one texture. */
function sided(up: string, down: string, side: string): Faces {
  return { up, down, north: side, south: side, east: side, west: side };
}

export async function healCatwalks(ctx: HealContext): Promise<void> {
  const uniform = (registry: string, display: string, path: string) =>
    heal(ctx, registry, 0, display, allSides(path));
  await uniform("catwalks:sturdy_rail", "Sturdy Rail", "sturdy_rail/normal");
  await uniform("catwalks:sturdy_rail_powered", "Sturdy Powered Rail", "sturdy_rail/booster_off");
  await uniform(
    "catwalks:sturdy_rail_detector",
    "Sturdy Detector Rail",
    "sturdy_rail/detector_off",
  );
  await uniform(
    "catwalks:sturdy_rail_activator",
    "Sturdy Activator Rail",
    "sturdy_rail/activator_off",
  );
  await uniform("catwalks:support_column", "Support Column", "support");
  await heal(
    ctx,
    "catwalks:scaffold",
    1,
    "Builder's Scaffold",
    sided("scaffold_builders_top", "scaffold_builders_top", "scaffold_builders_side"),
  );
  await heal(
    ctx,
    "catwalks:catwalk_unlit",
    0,
    "Catwalk",
    sided("transparent", "catwalk/bottom/plain/no_lights", "catwalk/side/plain/no_lights"),
  );
  // "Tape" isn't a texture swap on the same block: the pack's NEI dump registers it as its own
  // block, "catwalks:catwalk_unlit_tape" (id 3101, plain catwalk_unlit is 3102). No item backs it
  // (the tape is applied in-world), so it never shows in the roster's placeable listing, but it
  // is a genuine confirmable registry+meta for export. Public source stores render state on the
  // TileEntity rather than a model, so meta 0 (the only placeable state) is the safe default.
  await heal(
    ctx,
    "catwalks:catwalk_unlit_tape",
    0,
    "Catwalk (Tape)",
    sided("transparent", "catwalk/bottom/tape/no_lights", "catwalk/side/tape/no_lights"),
  );
  await heal(ctx, "catwalks:cagedLadder_north_unlit", 0, "Caged Ladder", {
    up: "ladder/side/plain/no_lights",
    down: "ladder/bottom/plain/no_lights",
    north: "ladder/front/plain/no_lights",
    south: "ladder/ladder/plain/no_lights",
    east: "ladder/side/plain/no_lights",
    west: "ladder/side/plain/no_lights",
  });
}

/**
 * One confirmed, per-face-textured cube. `paths` are relative to textures/blocks/. Skipped (with
 * a warning) if any named face's file is missing, rather than binding a half-textured block.
 */
async function heal(
  ctx: HealContext,
  registry: string,
  meta: number,
  display: string,
  paths: Faces,
): Promise<void> {
  const faces: Partial<Record<McSide, string>> = {};
  for (const [side, path] of Object.entries(paths) as [McSide, string][]) {
    const ref = `${TEXTURES}/${path}`;
    const key = await ctx.ensureTexture(ref);
    if (key === null) {
      ctx.warnings.push(`catwalks: missing texture ${ref} for ${display}, skipped`);
      return;
    }
    faces[side] = key;
  }
  const name = ctx.existingFor(registry, meta) ?? ctx.uniqueName(display);
  // The colour is the sides', not the top's: a catwalk's top is a transparent texture.
  const color = ctx.averageColor(faces.north ?? "");
  if (ctx.addCube(name, faces, { color })) ctx.confirmRegistry(name, { registry, meta });
}
