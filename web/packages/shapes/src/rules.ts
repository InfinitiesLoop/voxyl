// Which parts may share one cell: a port of the Godot app's ShapeRules.gd, itself a port of
// Forge Microblocks' occlusion rules (TSlottedTile, TMicroOcclusion, TNormalOcclusion,
// PartialOcclusionTest), so anything that can be built here could exist in-game.
//
// Validity depends only on the cell's own parts, never on a palette. Where the mod asks "same
// material?", this asks "same semantic?": two semantics may map to the same block, but treating
// them as different is the stricter reading, so no palette edit can make a valid cell invalid.

import { ARCH_SHAPES, ARCH_SLOTS } from "./arch.ts";
import {
  type Box8,
  CENTER_SLOT,
  MICRO_SHAPES,
  type MicroShape,
  microBoxes,
  microSlotCount,
  ringBoxes,
  unpackEdgeBits,
} from "./micro.ts";

/** A part as the rules see it; semantics only need to compare equal. */
export interface RulePart {
  readonly semantic: unknown;
  readonly shape: string;
  readonly slot: number;
}

/**
 * Why a part can't join a cell:
 * - `invalid_slot`: the shape is unknown or has no such slot
 * - `exclusive`: an architecture shape needs the cell to itself (or one is already there)
 * - `slot_taken`: another part already sits in the same slot
 * - `opposite_faces`: two thick faces on opposite sides would overlap
 * - `micro_conflict`: two slotted parts of different semantics collide where they meet
 * - `hard_overlap`: a centered post or a hollow face's frame would be cut into
 * - `occluded`: some part would be left with no space of its own
 */
export type RejectReason =
  | "invalid_slot"
  | "exclusive"
  | "slot_taken"
  | "opposite_faces"
  | "micro_conflict"
  | "hard_overlap"
  | "occluded";

/** Whether a shape takes a whole cell (architecture shapes do). */
export function isExclusive(shape: string): boolean {
  return shape in ARCH_SHAPES;
}

export function isValidSlot(shape: string, slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 0) return false;
  if (shape in ARCH_SHAPES) return slot < ARCH_SLOTS;
  return slot < microSlotCount(shape);
}

/** Why `part` can't be added to a cell holding `existing`, or null when it can. */
export function rejectPart(existing: readonly RulePart[], part: RulePart): RejectReason | null {
  if (!isValidSlot(part.shape, part.slot)) return "invalid_slot";
  if (isExclusive(part.shape)) return existing.length === 0 ? null : "exclusive";
  if (existing.some((p) => isExclusive(p.shape))) return "exclusive";
  const slot = fmpSlot(part);
  if (slot >= 0 && existing.some((p) => fmpSlot(p) === slot)) return "slot_taken";
  for (const p of existing) {
    const why = pairReason(p, part) ?? pairReason(part, p);
    if (why) return why;
  }
  return partialOcclusionOk([...existing, part]) ? null : "occluded";
}

/** The first reason a list of parts isn't a valid cell (each added in turn), or null. */
export function rejectCell(parts: readonly RulePart[]): RejectReason | null {
  for (let i = 0; i < parts.length; i++) {
    const why = rejectPart(parts.slice(0, i), parts[i] as RulePart);
    if (why) return why;
  }
  return null;
}

// --- The mod's tests ---

/** What the slot helpers read of a part. */
type Slotted = Pick<RulePart, "shape" | "slot">;

function micro(part: Slotted): MicroShape | undefined {
  return MICRO_SHAPES[part.shape];
}

function isPost(part: Slotted): boolean {
  return micro(part)?.family === "edge" && part.slot >= CENTER_SLOT;
}

function sizeOf(part: Slotted): number {
  return micro(part)?.size ?? 0;
}

/** The mod's slot index (faces 0-5, corners 7-14, edges 15-26), or -1 for a centered post. */
function fmpSlot(part: Slotted): number {
  switch (micro(part)?.family) {
    case "face":
    case "hollow":
      return part.slot;
    case "corner":
      return 7 + part.slot;
    case "edge":
      return part.slot >= CENTER_SLOT ? -1 : 15 + part.slot;
    default:
      return -1;
  }
}

/** Boxes others may overlap, but not cover completely. */
function partialBoxes(part: RulePart): Box8[] {
  const m = micro(part);
  if (m?.family === "hollow") return ringBoxes(part.slot, m.size, 0, 8, 1, 7);
  return microBoxes(part.shape, part.slot);
}

/** Boxes nothing else may intersect: a centered post's body, a hollow face's frame. */
function hardBoxes(part: RulePart): Box8[] {
  const m = micro(part);
  if (m?.family === "hollow") return ringBoxes(part.slot, m.size, 1, 7, 2, 6);
  if (isPost(part)) return microBoxes(part.shape, part.slot);
  return [];
}

function intersects(a: Box8, b: Box8): boolean {
  return a[0] < b[3] && b[0] < a[3] && a[1] < b[4] && b[1] < a[4] && a[2] < b[5] && b[2] < a[5];
}

function pairReason(a: RulePart, b: RulePart): RejectReason | null {
  if (occlusionTest(a, b)) return null;
  if ((isPost(a) || isPost(b) || micro(a)?.family === "hollow") && !normalTest(a, b)) {
    return "hard_overlap";
  }
  const s1 = fmpSlot(a);
  const s2 = fmpSlot(b);
  if (s1 >= 0 && s2 >= 0 && s1 < 6 && s2 === (s1 ^ 1)) return "opposite_faces";
  return "micro_conflict";
}

/** Whether `a` tolerates `b` beside it. */
function occlusionTest(a: RulePart, b: RulePart): boolean {
  if (isPost(a)) {
    // Posts on different axes may cross; a solid face on the post's own axis caps it.
    if (isPost(b)) return a.slot !== b.slot;
    if (micro(b)?.family === "face" && b.slot >> 1 === a.slot - CENTER_SLOT) return true;
    return normalTest(a, b);
  }
  if (micro(a)?.family === "hollow" && !normalTest(a, b)) return false;
  if (isPost(b)) return true;
  return microTest(a, b);
}

/** a's hard boxes must not intersect any of b's hard or partial boxes. */
function normalTest(a: RulePart, b: RulePart): boolean {
  const mine = hardBoxes(a);
  if (mine.length === 0) return true;
  const theirs = [...hardBoxes(b), ...partialBoxes(b)];
  return !mine.some((m) => theirs.some((t) => intersects(m, t)));
}

/** Priority class of a mod slot: faces 2, corners 1, edges 0. */
function priority(fslot: number): number {
  return fslot < 6 ? 2 : fslot < 15 ? 1 : 0;
}

function edgeAxisMask(e: number): number {
  return e >> 2 === 0 ? 6 : e >> 2 === 1 ? 5 : 3;
}

function edgeCornerOk(e: number, c: number): boolean {
  return (c & edgeAxisMask(e)) === unpackEdgeBits(e);
}

/** Slotted parts whose sizes sum past a cell may collide, depending on where they sit. */
function microTest(a: RulePart, b: RulePart): boolean {
  if (sizeOf(a) + sizeOf(b) <= 8) return true;
  const s1 = fmpSlot(a);
  const s2 = fmpSlot(b);
  const p1 = priority(s1);
  const p2 = priority(s2);
  if (p1 === 2 && p2 === 2 && s2 === (s1 ^ 1)) return false;
  if (a.semantic === b.semantic) return true;
  if (p1 === 1 && p2 === 1) {
    const mask = (s1 - 7) ^ (s2 - 7);
    if (mask === 3 || mask === 5 || mask === 6) return false;
  }
  if (p1 === 0 && p2 === 1 && !edgeCornerOk(s1 - 15, s2 - 7)) return false;
  if (p1 === 1 && p2 === 0 && !edgeCornerOk(s2 - 15, s1 - 7)) return false;
  if (p1 === 0 && p2 === 0) {
    const e1 = s1 - 15;
    const e2 = s2 - 15;
    if ((e1 & 0xc) === (e2 & 0xc) && ((e1 & 3) ^ (e2 & 3)) === 3) return false;
  }
  return true;
}

/** Every part (bar hollow faces, which may be covered) must own at least one eighth-cell. */
function partialOcclusionOk(parts: readonly RulePart[]): boolean {
  const grid = new Int32Array(512);
  parts.forEach((part, i) => {
    for (const b of partialBoxes(part)) {
      for (let y = b[1]; y < b[4]; y++)
        for (let z = b[2]; z < b[5]; z++)
          for (let x = b[0]; x < b[3]; x++) {
            const k = x + z * 8 + y * 64;
            grid[k] = grid[k] === 0 ? i + 1 : -1;
          }
    }
  });
  const visible = new Set<number>();
  for (const v of grid) if (v > 0) visible.add(v - 1);
  return parts.every((p, i) => micro(p)?.family === "hollow" || visible.has(i));
}

// --- Who shows where parts overlap -----------------------------------------------------
//
// Parts may legally overlap (a panel's end runs into the panel beside it, a strip lies along
// a cover). Forge Microblocks trims the part that yields back to where the other begins, so
// no two faces coincide (MicroOcclusion.recalcBounds, PostMicroblockClient; the Godot app's
// ShapeRules.render_boxes). A mesher that fills a grid of eighths from every part can't
// z-fight, so all that is left to decide is whose colour the shared eighths take: paint the
// parts in this order and the last one wins, as the mod's trim leaves it.
//
// Strips yield to corners, corners to faces; between two of a kind the thinner yields; between
// equals the lower slot yields. Centered posts yield to faces capping them, and between two
// posts the thinner, then the higher slot, yields (the mod's post rule). Posts never meet
// strips or corners in a valid cell, so where they sit between those classes doesn't matter.

const RENDER_CLASS = { edge: 0, corner: 1, post: 1.5, face: 2, hollow: 2 } as const;

/**
 * Sorts parts into painting order: a part that yields where two overlap comes before the one
 * that shows. Parts that aren't microblocks keep their place at the end.
 */
export function renderOrder<T extends Slotted>(parts: readonly T[]): T[] {
  const key = (p: T): [number, number, number] => {
    const shape = micro(p);
    if (!shape) return [3, 0, 0];
    if (isPost(p)) return [RENDER_CLASS.post, shape.size, -p.slot];
    return [RENDER_CLASS[shape.family], shape.size, fmpSlot(p)];
  };
  return parts
    .map((part, i) => ({ part, i, k: key(part) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i)
    .map((e) => e.part);
}
