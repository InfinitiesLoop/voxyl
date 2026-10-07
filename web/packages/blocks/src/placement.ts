// The placement profile a block implies, read from its blockstate properties. A semantic's
// form can set its own profile (intent); when it doesn't, the block its look names supplies
// one, so stairs face the player and a log follows the face that was clicked. There is no
// per-block code: the properties say which of the named profiles fits.

import { PLACEMENTS, type PlacementProfile, type Side } from "@voxyl/core";
import type { Block } from "./library.ts";
import { parseProps } from "./variants.ts";

/** Blockstate properties that orient a block (the same set variants.ts matches on). */
const ORIENTATION = new Set(["facing", "half", "type", "axis", "face"]);
const HORIZONTAL = new Set(["north", "east", "south", "west"]);

/**
 * How a block of this shape is placed. A plain cube (or a fence, which doesn't turn) reports
 * the cube profile, so every rotation is one stored state.
 */
export function profileOfBlock(block: Block): PlacementProfile {
  const values = new Map<string, Set<string>>();
  for (const key of Object.keys(block.variants ?? {})) {
    for (const [name, value] of Object.entries(parseProps(key))) {
      if (!ORIENTATION.has(name)) continue;
      let set = values.get(name);
      if (!set) {
        set = new Set();
        values.set(name, set);
      }
      set.add(value);
    }
  }
  const facing = values.get("facing") ?? new Set<string>();
  const half = values.get("half") ?? new Set<string>();
  const type = values.get("type") ?? new Set<string>();
  const axis = values.get("axis") ?? new Set<string>();
  const face = values.get("face") ?? new Set<string>();
  const horizontal = facing.size > 0 && [...facing].every((d) => HORIZONTAL.has(d));

  // A pillar: the axis it lies along is the face it was placed against.
  if (axis.has("x") && axis.has("y") && axis.has("z") && facing.size === 0) return PLACEMENTS.log;
  // A slab: upright or upside down, and spinning it changes nothing.
  if (type.has("bottom") && type.has("top") && facing.size === 0) return PLACEMENTS.slab;
  // Stairs and trapdoors: four facings, and the upper half of a click flips them.
  if (horizontal && (half.has("top") || half.has("bottom"))) return PLACEMENTS.stairs;
  // Buttons and levers: they hang on the face, and some also on the ceiling.
  if (face.size > 0) {
    const up: Side[] = ["up", "north", "east", "south", "west"];
    if (face.has("ceiling")) up.push("down");
    return { up, symmetry: "spin", pick: "attach" };
  }
  // A hopper points into the face; it never faces up.
  if (facing.has("down") && !facing.has("up")) return PLACEMENTS.hopper;
  // Dispensers, observers, pistons: the front can point anywhere.
  if (facing.has("up") && facing.has("down")) return PLACEMENTS.facing;
  // Furnaces, doors, glazed terracotta: the front stays horizontal.
  if (horizontal) return PLACEMENTS.horizontal;
  return PLACEMENTS.cube;
}
