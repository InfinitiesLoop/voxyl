// GregTech: machines and tier casings.
//
// GregTech (1.7.10) has no model or blockstate JSON. It composites a machine's look in Java from
// an opaque voltage hull (iconsets/MACHINE_<TIER>_{SIDE,TOP,BOTTOM}) plus a transparent overlay
// per machine (basicmachines/<machine>/OVERLAY_<FACE>[_ACTIVE]), so the plain roster import
// yields invisible overlay cubes and cryptic hull cubes. This rebuilds the composite the
// renderer would draw, names it from GregTech.lang (keyed by the same folder name, e.g.
// gt.blockmachines.basicmachine.bender.tier.01.name = Basic Bending Machine) and removes the
// cubes it supersedes. A healed machine carries no Minecraft identity: GregTech packs its
// machines' metas in the tile entity, so there is no roster row to bind one to.

import type { McSide } from "@voxyl/blocks";
import type { HealContext } from "../legacy/heal.ts";
import {
  BASICMACHINES,
  CASING_TIERS,
  FOLDER_ALIAS,
  ICONSETS,
  MACHINE_TIERS,
  MACHINES_TEX_DIR,
} from "./gregtech-data.ts";

type Faces = Partial<Record<McSide, string>>;

/** The prefix of a machine's name keys in GregTech.lang. */
const LANG_PREFIX = "gt.blockmachines.basicmachine.";

export async function healGregtech(ctx: HealContext): Promise<void> {
  const names = await parseMachineNames(ctx);
  await healCasings(ctx);
  await healMachines(ctx, names);
  removeSuperseded(ctx);
}

// --- Tier machine casings: MACHINE_<TIER>_{SIDE,TOP,BOTTOM} -> "<TIER> Machine Casing" ---

async function healCasings(ctx: HealContext): Promise<void> {
  for (const tier of CASING_TIERS) {
    if (!ctx.sourceHasTexture(`${ICONSETS}/MACHINE_${tier}_SIDE`)) continue;
    const faces = await hullFaces(ctx, tier);
    if (!faces) continue;
    ctx.addCube(ctx.uniqueName(`${tier} Machine Casing`), faces, { color: avg(ctx, faces.north) });
  }
}

/**
 * The six-face binding for a tier's plain hull (verbatim textures, no overlay): SIDE on the four
 * horizontals, TOP and BOTTOM on the caps. Null if the side hull can't be read.
 */
async function hullFaces(ctx: HealContext, tier: string): Promise<Faces | null> {
  const side = await ctx.ensureTexture(`${ICONSETS}/MACHINE_${tier}_SIDE`);
  if (side === null) return null;
  const top = (await ctx.ensureTexture(`${ICONSETS}/MACHINE_${tier}_TOP`)) ?? side;
  const bottom = (await ctx.ensureTexture(`${ICONSETS}/MACHINE_${tier}_BOTTOM`)) ?? side;
  return { north: side, east: side, south: side, west: side, up: top, down: bottom };
}

// --- Machines: overlay + hull -> a named, composited cube per tier (+ an Active variant) ---

async function healMachines(ctx: HealContext, names: Names): Promise<void> {
  for (const folder of machineFolders(ctx)) {
    for (const [tierIndex, display] of tiersFor(folder, names)) {
      if (tierIndex < 1 || tierIndex > MACHINE_TIERS.length) continue;
      const tier = MACHINE_TIERS[tierIndex - 1] ?? "";
      await emitMachine(ctx, folder, tier, display, false);
      await emitMachine(ctx, folder, tier, display, true);
    }
  }
}

/**
 * One machine block: composite each face's overlay over the tier hull and bind a cube. `active`
 * builds the running variant from the `_ACTIVE` overlays (skipped when the machine has none).
 */
async function emitMachine(
  ctx: HealContext,
  folder: string,
  tier: string,
  display: string,
  active: boolean,
): Promise<void> {
  if (active && !ctx.sourceHasTexture(`${BASICMACHINES}/${folder}/OVERLAY_FRONT_ACTIVE`)) return;
  const outBase = `gregtech:heal/${folder}_${tier.toLowerCase()}${active ? "_active" : ""}`;
  const face = (name: string, key: string) =>
    faceTexture(ctx, `${outBase}/${name}`, tier, folder, key, active);
  const front = await face("front", "FRONT");
  const side = await face("side", "SIDE");
  const top = await face("top", "TOP");
  const bottom = await face("bottom", "BOTTOM");
  if (!front && !side) return; // nothing to show for this machine at this tier
  // Resting facing north: the front on -Z, the same side texture on the other three horizontals.
  const lateral = side || front;
  const faces: Faces = {
    north: front || lateral,
    east: lateral,
    south: lateral,
    west: lateral,
    up: top || lateral,
    down: bottom || lateral,
  };
  ctx.addCube(ctx.uniqueName(active ? `${display} (Active)` : display), faces, {
    color: avg(ctx, faces.north),
  });
}

/**
 * The composited texture key for one face, or "": the overlay over the hull when the overlay
 * exists (an Active face a machine doesn't animate falls back to the idle overlay), else the
 * plain hull. Hull SIDE backs the front and sides; TOP and BOTTOM back the caps.
 */
async function faceTexture(
  ctx: HealContext,
  outKey: string,
  tier: string,
  folder: string,
  face: string,
  active: boolean,
): Promise<string> {
  let hull = `${ICONSETS}/MACHINE_${tier}_${face === "TOP" || face === "BOTTOM" ? face : "SIDE"}`;
  if (!ctx.sourceHasTexture(hull)) hull = ""; // no hull for this tier: composite over neutral grey
  let overlay = `${BASICMACHINES}/${folder}/OVERLAY_${face}${active ? "_ACTIVE" : ""}`;
  if (active && !ctx.sourceHasTexture(overlay)) {
    overlay = `${BASICMACHINES}/${folder}/OVERLAY_${face}`; // this face doesn't animate
  }
  if (ctx.sourceHasTexture(overlay)) {
    return (await ctx.compositeTexture(outKey, hull, overlay)) ?? "";
  }
  if (hull) return (await ctx.ensureTexture(hull)) ?? "";
  return "";
}

/** The machine subfolders under textures/blocks/basicmachines (each is one machine's overlays). */
function machineFolders(ctx: HealContext): string[] {
  const seen = new Set<string>();
  for (const rel of ctx.source.listFilesRecursive(MACHINES_TEX_DIR)) {
    const slash = rel.indexOf("/");
    if (slash > 0) seen.add(rel.slice(0, slash));
  }
  return [...seen].sort();
}

/**
 * Tier index to display name for a machine: from GregTech.lang when its folder maps to a lang
 * entry, else a derived "<Pretty Folder> (<TIER>)" for every tier, so an import without the
 * instance's lang still yields usable if generic names. A Map: tiers keep the lang's order.
 */
function tiersFor(folder: string, names: Names): ReadonlyMap<number, string> {
  const key = langKeyFor(folder, names);
  const found = key === "" ? undefined : names.get(key);
  if (found) return found;
  const pretty = prettify(folder);
  return new Map(MACHINE_TIERS.map((tier, i) => [i + 1, `${pretty} (${tier})`]));
}

function langKeyFor(folder: string, names: Names): string {
  const normal = norm(folder);
  if (names.has(normal)) return normal;
  const alias = FOLDER_ALIAS[folder];
  if (alias !== undefined && names.has(norm(alias))) return norm(alias);
  return "";
}

// --- GregTech.lang (display names keyed by machine folder and tier index) ---

type Names = Map<string, Map<number, string>>;

/**
 * norm(folder) to {tier index to display} from the instance's GregTech.lang. The keys look like
 * `S:gt.blockmachines.basicmachine.<folder>.tier.<NN>.name=<Display>`.
 */
async function parseMachineNames(ctx: HealContext): Promise<Names> {
  const text = await ctx.siblingText("GregTech.lang");
  const out: Names = new Map();
  if (text === "") {
    ctx.warnings.push(
      "gregtech: GregTech.lang not found near the import source — machines named generically",
    );
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("S:")) key = key.slice(2);
    if (!key.startsWith(LANG_PREFIX) || !key.endsWith(".name")) continue;
    const mid = key.slice(LANG_PREFIX.length); // "<folder>.tier.<NN>.name"
    const tierAt = mid.indexOf(".tier.");
    if (tierAt < 0) continue;
    const after = mid.slice(tierAt + ".tier.".length); // "<NN>.name"
    const dot = after.indexOf(".");
    const tierText = dot >= 0 ? after.slice(0, dot) : after;
    if (!/^[+-]?\d+$/.test(tierText)) continue;
    const normal = norm(mid.slice(0, tierAt));
    const tiers = out.get(normal) ?? new Map<number, string>();
    out.set(normal, tiers);
    tiers.set(Number.parseInt(tierText, 10), line.slice(eq + 1).trim());
  }
  return out;
}

// --- Remove the roster cubes this heal supersedes ---

/**
 * Drops every block whose model is built entirely from basicmachines/ overlays or from a tier
 * hull face: the transparent overlay cubes and the raw `iconsets/machine_lv` hulls the composited,
 * named machines and casings replace. Blocks that also use other textures (the named structural
 * casings like COKE_OVEN_CASING) stay.
 */
function removeSuperseded(ctx: HealContext): void {
  const hulls = new Set<string>();
  for (const tier of CASING_TIERS) {
    for (const face of ["SIDE", "TOP", "BOTTOM"]) hulls.add(`${ICONSETS}/MACHINE_${tier}_${face}`);
  }
  const overlayPrefix = `${BASICMACHINES}/`;
  for (const name of Object.keys(ctx.draft.blocks)) {
    if (ctx.blockModelKeys(name).some((m) => m.startsWith("gregtech:heal/"))) continue; // just added
    const textures = ctx.blockTextureKeys(name);
    if (textures.length === 0) continue;
    if (textures.every((key) => key.startsWith(overlayPrefix) || hulls.has(key))) {
      ctx.removeBlock(name);
    }
  }
}

// --- Small helpers ---

/** A texture's average colour, neutral grey when there is none. */
function avg(ctx: HealContext, key: string | undefined): string {
  return key ? ctx.averageColor(key) : "#808080";
}

/** The lang spells a folder without underscores or case. */
function norm(s: string): string {
  return s.replaceAll("_", "").toLowerCase();
}

/**
 * "alloy_smelter" to "Alloy Smelter", the way Godot's `String.capitalize()` does it: snake and
 * camel case both split into words, digits split off letters, each word lower-cased then
 * capitalised.
 */
function prettify(folder: string): string {
  const upper = (c: string) => c >= "A" && c <= "Z";
  const lower = (c: string) => c >= "a" && c <= "z";
  const digit = (c: string) => c >= "0" && c <= "9";
  let spaced = "";
  let start = 0;
  for (let i = 1; i < folder.length; i++) {
    const prev = folder[i - 1] ?? "";
    const cur = folder[i] ?? "";
    const next = folder[i + 1] ?? "";
    if (
      (lower(prev) && upper(cur)) ||
      ((upper(prev) || digit(prev)) && upper(cur) && lower(next)) ||
      (digit(prev) && lower(cur) && lower(next)) ||
      ((upper(prev) || lower(prev)) && digit(cur))
    ) {
      spaced += `${folder.slice(start, i)}_`;
      start = i;
    }
  }
  spaced += folder.slice(start);
  return spaced
    .toLowerCase()
    .replaceAll("_", " ")
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
