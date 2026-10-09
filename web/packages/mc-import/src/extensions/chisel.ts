// Chisel (team.chisel, 1.7.10): decorative block variations whose meta -> texture mapping lives in
// Java bytecode (legacy/chisel-variations.ts) rather than in any blockstate JSON, so the roster
// import can only guess at them. This resolves every group of that table to real texture files
// and emits one block per meta, named from Chisel's own lang file.
//
// A table entry names a texture base, but the file Chisel loads for it is one of several shapes:
// a bare file, one under a folder named for the group, or (columns, pillars, some wall panels) a
// side + top pair (`foo-side.png` + `foo-top.png`, or `-ctmv` / `-ctmh` connected-texture
// variants of the side face). Against the real GTNH Chisel jar this resolves ~97% of the table;
// the remaining few dozen one-off names are dropped with a warning, like any other unmatched
// roster row.

import type { McSide } from "@voxyl/blocks";
import { CHISEL_VARIATIONS, isChiselPaneGroup } from "../legacy/chisel-variations.ts";
import type { HealContext } from "../legacy/heal.ts";
import { readText } from "../sources/index.ts";
import { parseChiselLang, prettifyGroup } from "./chisel-lang.ts";

const TEX = "chisel:blocks";
const SIDE_SUFFIXES = ["-side", "-ctmv", "-ctmh"] as const;
const SIDES: readonly McSide[] = ["up", "down", "north", "south", "east", "west"];

type Faces = Partial<Record<McSide, string>>;

/**
 * "futura" metas 2/4/5 (controller / controllerPurple / uberWavy) are registered through
 * team.chisel.client.render.SubmapManagerFakeController, not a plain addVariation(String) or the
 * top/side pair the other column-shaped groups use. Each 32-wide frame of the accompanying
 * .mcmeta's animation is a 2x2 grid of four unrelated 16x16 icons (a fake computer screen: Java
 * picks one per placement). Binding the whole 32x32 frame, what the generic resolution would do,
 * squashes all four icons onto every face. A block type has one texture, never one that varies
 * by position (principle 1), so a fixed representative icon is cropped instead.
 * group -> meta -> texture base to crop.
 */
const FAKE_CONTROLLER_CROP: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  futura: {
    2: "futura/WIP/controller",
    4: "futura/WIP/controllerPurple",
    5: "futura/WIP/uberWavy",
  },
};

export async function healChisel(ctx: HealContext): Promise<void> {
  // Inside the Chisel jar itself, not a sibling file like GregTech.lang.
  const lang = parseChiselLang(await readText(ctx.source, "chisel/lang/en_US.lang"));
  for (const [group, metas] of Object.entries(CHISEL_VARIATIONS)) {
    const registry = `chisel:${group}`;
    const groupName = lang.get(`chisel.${group}`) ?? prettifyGroup(group);
    const pane = isChiselPaneGroup(group);
    // Ascending by meta (object order for integer keys), as the Godot table lists them.
    for (const [metaKey, base] of Object.entries(metas)) {
      const meta = Number(metaKey);
      const names = nameCandidates(lang, group, groupName, meta);
      if (pane) {
        await healPane(ctx, registry, group, meta, base, names);
        continue;
      }
      const fakeController = FAKE_CONTROLLER_CROP[group]?.[meta];
      const faces = fakeController
        ? await iconCropFaces(ctx, fakeController)
        : await chiselFaces(ctx, group, base);
      if (!faces) {
        ctx.warnings.push(
          `chisel: no texture match for ${registry} meta ${meta} (${base}), skipped`,
        );
        continue;
      }
      const name = claimName(ctx, registry, meta, names);
      ctx.addCube(name, faces, { color: ctx.averageColor(faces.north ?? "") });
      ctx.confirmRegistry(name, { registry, meta });
    }
  }
}

/**
 * A pane-shaped group (glass_pane, iron_bars, the 16 stained panes) healed with real connecting
 * pane geometry instead of a full cube. Chisel's 1.7.10 pane renderer already split most
 * variants' look into the two textures a vanilla pane model uses, a "side" (the flat face) and a
 * "top" (the rim). Not every variant has a dedicated "-top" though (the "Screen Pane" is one bare
 * file), so those fall back to the single texture for both roles: the opposite order from the
 * cube path, since a pane benefits from a real rim texture when one exists.
 */
async function healPane(
  ctx: HealContext,
  registry: string,
  group: string,
  meta: number,
  base: string,
  names: readonly string[],
): Promise<void> {
  const pair = await topSide(ctx, group, base);
  const side = pair ? pair.side : await single(ctx, group, base);
  const edge = pair ? pair.top : side;
  if (!side || !edge) {
    ctx.warnings.push(`chisel: no texture match for ${registry} meta ${meta} (${base}), skipped`);
    return;
  }
  const name = claimName(ctx, registry, meta, names);
  ctx.addPane(name, side, edge, { color: ctx.averageColor(side) });
  ctx.confirmRegistry(name, { registry, meta });
}

/**
 * Chisel names a block in two places: the group ("Glass", `tile.chisel.<group>.name`) and, per
 * variation, a description that is the variation's real in-game name ("Bubble Glass", "Asymmetrical
 * Leaded Glass", `tile.<group>.<meta>.desc`). NEI and the roster import show only the group name,
 * so every variation of a group would be "Glass", "Glass (2)"... and tell nothing apart. The name
 * of a variation is its own description, whichever meta it is, so the list is searchable by what
 * the block looks like.
 *
 * Returns the names to try, best first; `claimName` takes the first one no other block holds.
 * Where two groups share a description ("Marble Pillar" in two registries, "White Bubble Glass"
 * for a glass and its pane) the later one is qualified with its group, so the names stay both
 * unique and the same on every run.
 */
function nameCandidates(
  lang: ReadonlyMap<string, string>,
  group: string,
  groupName: string,
  meta: number,
): string[] {
  const named = variantName(lang, group, meta);
  const plain = named ?? (meta === 0 ? groupName : `${groupName} ${meta}`);
  const qualified = (qualifier: string) =>
    plain.toLowerCase().includes(qualifier.toLowerCase()) ? null : `${plain} (${qualifier})`;
  const byGroup = qualified(groupName);
  const byFolder = qualified(prettifyGroup(group));
  // A short description ("Screen", "White", "Ceramic") says nothing about what it is a variation
  // of ('Bubble Pane' does say it, in a group of Glass Panes), so it leads with its group; a longer one ("Asymmetrical Leaded Glass") already does.
  const lastWord = groupName.split(/\s+/).at(-1)?.toLowerCase() ?? "";
  const terse =
    plain.split(/\s+/).length <= SHORT_NAME_WORDS && !plain.toLowerCase().includes(lastWord);
  const out = terse && byGroup ? [byGroup] : [plain];
  for (const name of [plain, byGroup, byFolder]) if (name && !out.includes(name)) out.push(name);
  return out;
}

/** A name of this many words or fewer is qualified with its group (see `nameCandidates`). */
const SHORT_NAME_WORDS = 2;

/** Chisel's own name for one variation, or undefined when the lang gives none that is a name. */
function variantName(
  lang: ReadonlyMap<string, string>,
  group: string,
  meta: number,
): string | undefined {
  // The dyed glass families: their own key shape (see chisel-lang.ts).
  const dyed = lang.get(`SGP_DISPLAY:${group}:${meta}`);
  if (dyed !== undefined) return dyed;
  const desc = lang.get(`${group}.${meta}`)?.trim();
  // A few descriptions are a tooltip, not a name: "tile.andesite.0.desc=Generates in your world".
  if (!desc || TOOLTIP.test(desc)) return undefined;
  return desc;
}

const TOOLTIP = /^generates in /i;

/**
 * The name a block of this identity goes by.
 *
 * A block this healer made on an earlier run keeps its name (a heal is keyed by identity, so
 * running again changes nothing and ids stay put). A block the roster import made from NEI's
 * display text ("Concrete", "Concrete (2)"...: its model is `<ns>:nei/<name>`) has no worth as a
 * name, so it gives way: the first candidate no other block holds is taken, else the last with a
 * number, and the roster's block and model are dropped. The result does not depend on what the
 * roster called it, so every run of the same install names the same blocks the same.
 */
function claimName(
  ctx: HealContext,
  registry: string,
  meta: number,
  candidates: readonly string[],
): string {
  const existing = ctx.existingFor(registry, meta);
  const model =
    existing === undefined ? undefined : ctx.draft.block(existing)?.variants?.[""]?.model;
  if (existing !== undefined && !model?.includes(":nei/")) return existing;
  const free = candidates.find((name) => name === existing || !ctx.draft.hasBlock(name));
  if (model) delete ctx.draft.models[model];
  if (existing !== undefined && free !== existing) ctx.removeBlock(existing);
  return free ?? ctx.uniqueName(candidates.at(-1) ?? registry);
}

/** All six faces on one texture, or top/bottom on a "top" file and the sides on a "side" file. */
async function chiselFaces(ctx: HealContext, group: string, base: string): Promise<Faces | null> {
  const one = await single(ctx, group, base);
  if (one) return allSides(one);
  const pair = await topSide(ctx, group, base);
  if (!pair) return null;
  return {
    up: pair.top,
    down: pair.top,
    north: pair.side,
    south: pair.side,
    east: pair.side,
    west: pair.side,
  };
}

/** All six faces on the top-left 16x16 icon cropped from `base`'s first frame. */
async function iconCropFaces(ctx: HealContext, base: string): Promise<Faces | null> {
  const ref = `${TEX}/${base}`;
  if (!ctx.sourceHasTexture(ref)) return null;
  const key = await ctx.croppedTexture(
    `chisel:heal/icon_${base.replaceAll("/", "_")}`,
    ref,
    [0, 0, 16, 16],
  );
  return key ? allSides(key) : null;
}

const allSides = (key: string): Faces => Object.fromEntries(SIDES.map((side) => [side, key]));

/** The file names a table entry may be stored under: as written, or under its group's folder. */
const candidates = (group: string, base: string) => [base, `${group.toLowerCase()}/${base}`];

async function single(ctx: HealContext, group: string, base: string): Promise<string | null> {
  for (const candidate of candidates(group, base)) {
    const ref = `${TEX}/${candidate}`;
    if (!ctx.sourceHasTexture(ref)) continue;
    const key = await ctx.ensureTexture(ref);
    if (key) return key;
  }
  return null;
}

/**
 * The resolved top + side textures of a column / pillar / pane-shaped group, null if no
 * candidate and suffix combination resolves both files. A cube puts them on its up/down vs
 * horizontal faces, a pane on its rim vs flat face: same two files, different geometry.
 */
async function topSide(
  ctx: HealContext,
  group: string,
  base: string,
): Promise<{ top: string; side: string } | null> {
  for (const candidate of candidates(group, base)) {
    const topRef = `${TEX}/${candidate}-top`;
    if (!ctx.sourceHasTexture(topRef)) continue;
    for (const suffix of SIDE_SUFFIXES) {
      const sideRef = `${TEX}/${candidate}${suffix}`;
      if (!ctx.sourceHasTexture(sideRef)) continue;
      const top = await ctx.ensureTexture(topRef);
      const side = await ctx.ensureTexture(sideRef);
      if (top && side) return { top, side };
    }
  }
  return null;
}
