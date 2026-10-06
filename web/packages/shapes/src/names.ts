// Slot names a person or a model can read and write, as the Godot app's ShapeCatalog named
// them: a face by its side ("down"), a corner or edge by the sides it touches ("up-north-west",
// "down-east"), a centered post by its axis ("center-y"), and an architecture slot by where the
// shape's top points and its turn about that ("up=north turn=1").

import { ARCH_SHAPES, ARCH_SLOTS, archRotation } from "./arch.ts";
import { CENTER_SLOT, MICRO_SHAPES, microSlotCount, unpackEdgeBits } from "./micro.ts";

/** Side names by side number (0 -Y, 1 +Y, 2 -Z, 3 +Z, 4 -X, 5 +X). */
export const SIDE_NAMES = ["down", "up", "north", "south", "west", "east"] as const;

const SIDE_ALIASES: Readonly<Record<string, number>> = {
  "-y": 0,
  "+y": 1,
  "-z": 2,
  "+z": 3,
  "-x": 4,
  "+x": 5,
  bottom: 0,
  top: 1,
};

/** The readable name of a slot, or the number as text if the shape has no such slot. */
export function slotName(shape: string, slot: number): string {
  if (shape in ARCH_SHAPES) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= ARCH_SLOTS) return String(slot);
    const m = archRotation(slot >> 2, slot & 3);
    return `up=${directionName([m[1], m[4], m[7]])} turn=${slot & 3}`;
  }
  const s = MICRO_SHAPES[shape];
  if (!s || !Number.isInteger(slot) || slot < 0 || slot >= microSlotCount(shape)) {
    return String(slot);
  }
  switch (s.family) {
    case "face":
    case "hollow":
      return SIDE_NAMES[slot] ?? String(slot);
    case "corner":
      return bitsName(slot, 0);
    case "edge":
      if (slot >= CENTER_SLOT) return `center-${["y", "z", "x"][slot - CENTER_SLOT]}`;
      return bitsName(unpackEdgeBits(slot), [1, 2, 4][slot >> 2] ?? 0);
  }
}

/** The slot a name (or a number, or digits) means for a shape, or -1. Word order is free. */
export function slotFromName(shape: string, name: string | number): number {
  const count = shape in ARCH_SHAPES ? ARCH_SLOTS : microSlotCount(shape);
  if (typeof name === "number" || /^\d+$/.test(name.trim())) {
    const n = Number(name);
    return Number.isInteger(n) && n >= 0 && n < count ? n : -1;
  }
  let text = name.trim().toLowerCase();
  if (shape in ARCH_SHAPES) text = text.replace(/:/g, "=").replace(/,/g, " ");
  else {
    const alias = SIDE_ALIASES[text];
    if (alias !== undefined) text = SIDE_NAMES[alias] ?? text;
  }
  const want = canonicalWords(text);
  for (let s = 0; s < count; s++) if (canonicalWords(slotName(shape, s)) === want) return s;
  return -1;
}

/** Every slot's name, by slot number. */
export function slotNames(shape: string): string[] {
  const count = shape in ARCH_SHAPES ? ARCH_SLOTS : microSlotCount(shape);
  return Array.from({ length: count }, (_, s) => slotName(shape, s));
}

/** "up", "north", ... for a unit axis vector. */
function directionName(v: readonly number[]): string {
  const [x = 0, y = 0, z = 0] = v.map(Math.round);
  if (y !== 0) return y > 0 ? "up" : "down";
  if (z !== 0) return z > 0 ? "south" : "north";
  return x > 0 ? "east" : "west";
}

/** "down-north-west" for axis bits (y 1, z 2, x 4 set = the positive side), skipping `skip`. */
function bitsName(bits: number, skip: number): string {
  const words: string[] = [];
  if (skip !== 1) words.push(bits & 1 ? "up" : "down");
  if (skip !== 2) words.push(bits & 2 ? "south" : "north");
  if (skip !== 4) words.push(bits & 4 ? "east" : "west");
  return words.join("-");
}

function canonicalWords(text: string): string {
  return text
    .split(/[\s_-]+/)
    .filter((w) => w !== "")
    .sort()
    .join(" ");
}
