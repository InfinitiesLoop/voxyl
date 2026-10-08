// Where a shaped part lands when a face is clicked: a port of Forge Microblocks'
// MicroblockPlacement (via the Godot app's ShapePlacement.gd and ShapeCatalog's placement
// grids) for microblocks, and ArchitectureCraft's orientOnPlacement for architecture shapes,
// so parts go exactly where a player of those mods expects.
//
// Pure geometry over a callback: the caller supplies the hit (which cell, which side of the
// box that was hit, and where, relative to the cell's min corner) and a way to read the parts
// already in a cell, and gets back the cell and slot to add, already checked against the
// cell rules. Nothing here reads a project.
//
//   side      the outward side of the face that was hit (0 -Y, 1 +Y, 2 -Z, 3 +Z, 4 -X, 5 +X)
//   vhit      the hit point relative to the hit cell's min corner, 0..1 on each axis
//   opposite  the "place on the far side" modifier

import { ARCH_SHAPES, archRotation, archSlot } from "./arch.ts";
import {
  CENTER_SLOT,
  edgeBetween,
  MICRO_SHAPES,
  type MicroShape,
  packEdgeBits,
  unpackEdgeBits,
} from "./micro.ts";
import { isExclusive, type RulePart, rejectPart } from "./rules.ts";

export type Vec3 = readonly [number, number, number];

/** Outward unit vector per side. */
export const SIDE_VECTORS: readonly Vec3[] = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];

const EPS = 0.0005;

/** The side (0..5) whose outward vector best matches a normal. */
export function sideFromNormal(n: Vec3): number {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return n[1] > 0 ? 1 : 0;
  if (az >= ax) return n[2] > 0 ? 3 : 2;
  return n[0] > 0 ? 5 : 4;
}

/** Signed distance of the hit from the face centre along side `s`'s outward vector. */
function proj(vhit: Vec3, s: number): number {
  const v = SIDE_VECTORS[s] ?? [0, 0, 0];
  return (vhit[0] - 0.5) * v[0] + (vhit[1] - 0.5) * v[1] + (vhit[2] - 0.5) * v[2];
}

function faceGridSlot(vhit: Vec3, side: number, size: number): number {
  const s1 = (side + 2) % 6;
  const s2 = (side + 4) % 6;
  const u = proj(vhit, s1);
  const v = proj(vhit, s2);
  if (Math.abs(u) < size && Math.abs(v) < size) return side ^ 1;
  if (Math.abs(u) > Math.abs(v)) return u > 0 ? s1 : s1 ^ 1;
  return v > 0 ? s2 : s2 ^ 1;
}

function cornerGridSlot(vhit: Vec3, side: number): number {
  const s1 = ((side & 6) + 3) % 6;
  const s2 = ((side & 6) + 5) % 6;
  const bu = proj(vhit, s1) >= 0 ? 1 : 0;
  const bv = proj(vhit, s2) >= 0 ? 1 : 0;
  const bw = (side & 1) ^ 1;
  return (bw << (side >> 1)) | (bu << (s1 >> 1)) | (bv << (s2 >> 1));
}

function edgeGridSlot(vhit: Vec3, side: number): number {
  const s1 = (side + 2) % 6;
  const s2 = (side + 4) % 6;
  const u = proj(vhit, s1);
  const v = proj(vhit, s2);
  if (Math.abs(u) < 0.25 && Math.abs(v) < 0.25) return -1;
  if (Math.abs(u) > 0.25 && Math.abs(v) > 0.25) {
    return edgeBetween(u > 0 ? s1 : s1 ^ 1, v > 0 ? s2 : s2 ^ 1);
  }
  const s = Math.abs(u) > Math.abs(v) ? (u > 0 ? s1 : s1 ^ 1) : v > 0 ? s2 : s2 ^ 1;
  return edgeBetween(side ^ 1, s);
}

/**
 * The slot a click at `vhit` on face `side` of the hit cell picks for a microblock shape, or
 * -1 for "no slot": for the edge family that is the face's centre zone (a centred post, when
 * the size allows one). Not for architecture shapes, which orient from the click instead.
 */
export function hitSlot(shape: string, vhit: Vec3, side: number): number {
  const s = MICRO_SHAPES[shape];
  if (!s) return -1;
  switch (s.family) {
    case "face":
      return faceGridSlot(vhit, side, 0.25);
    case "hollow":
      return faceGridSlot(vhit, side, 0.375);
    case "corner":
      return cornerGridSlot(vhit, side);
    case "edge":
      return edgeGridSlot(vhit, side);
  }
}

/** The slot across the cell from `slot`, mirrored over the clicked face's axis (FMP's `opposite`). */
export function oppositeSlot(shape: string, slot: number, side: number): number {
  const s = MICRO_SHAPES[shape];
  if (!s || slot < 0) return slot;
  switch (s.family) {
    case "face":
    case "hollow":
      return slot ^ 1;
    case "corner":
      return slot ^ (1 << (side >> 1));
    case "edge":
      if (slot >= CENTER_SLOT) return slot;
      return packEdgeBits(slot, unpackEdgeBits(slot) ^ (1 << (side >> 1)));
  }
}

/**
 * Whether the opposite modifier flips this placement (FMP's `sneakOpposite`): for a face-family
 * part only when it would land flush against the clicked face; always for edges and corners.
 */
export function usesOpposite(shape: string, slot: number, side: number): boolean {
  const s = MICRO_SHAPES[shape];
  if (s && (s.family === "face" || s.family === "hollow")) return slot === (side ^ 1);
  return true;
}

// --- Architecture shapes ---

/** How a click position picks an architecture shape's turn (AC's ShapeSymmetry). */
type Symmetry = "uni" | "bi" | "quad";

const ARCH_SYMMETRY: Readonly<Record<string, Symmetry>> = {
  roof_tile: "bi",
  roof_outer_corner: "uni",
  roof_inner_corner: "uni",
  roof_ridge: "bi",
  roof_smart_ridge: "quad",
  roof_valley: "bi",
  roof_smart_valley: "quad",
  slope_tile_a1: "bi",
  slope_tile_a2: "bi",
  slope_tile_b1: "bi",
  slope_tile_b2: "bi",
  slope_tile_b3: "bi",
  slope_tile_c1: "bi",
  slope_tile_c2: "bi",
  slope_tile_c3: "bi",
  slope_tile_c4: "bi",
};

/** The profile a roof presents on a local face (0 -Y .. 5 +X), or "None". */
function roofProfile(shape: string, localFace: number): string {
  switch (shape) {
    case "roof_tile":
      return localFace === 5 ? "Left" : localFace === 4 ? "Right" : "None";
    case "roof_outer_corner":
      return localFace === 3 ? "Left" : localFace === 4 ? "Right" : "None";
    case "roof_inner_corner":
      return localFace === 5 ? "Left" : localFace === 2 ? "Right" : "None";
    case "roof_ridge":
    case "roof_smart_ridge":
      return "Ridge";
    case "roof_valley":
    case "roof_smart_valley":
      return "Valley";
  }
  return "None";
}

const OPPOSITE_PROFILES: Readonly<Record<string, string>> = { Left: "Right", Right: "Left" };

function profilesMatch(a: string, b: string): boolean {
  const opposite = OPPOSITE_PROFILES[a];
  return opposite !== undefined ? opposite === b : a === b;
}

type Mat3 = ReturnType<typeof archRotation>;

/** The transpose, which is the inverse of a rotation. */
function applyInverse(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** The profile a placed shape shows on a world face (AC's Profile.getProfileGlobal). */
function profileGlobal(shape: string, side: number, turn: number, globalFace: number): string {
  if (!(shape in ARCH_SHAPES)) return "";
  const local = applyInverse(archRotation(side, turn), SIDE_VECTORS[globalFace] ?? [0, 0, 0]);
  return roofProfile(shape, sideFromNormal(local));
}

function turnForHit(side: number, hit: Vec3, symmetry: Symmetry): number {
  const h = applyInverse(archRotation(side, 0), hit);
  switch (symmetry) {
    case "bi":
      if (Math.abs(h[2]) > Math.abs(h[0])) return h[2] < 0 ? 2 : 0;
      return h[0] > 0 ? 1 : 3;
    case "uni":
      if (h[2] > 0) return h[0] < 0 ? 0 : 1;
      return h[0] > 0 ? 2 : 3;
    case "quad":
      return 0;
  }
}

/** The slot an architecture shape takes from where its face was clicked, ignoring neighbours. */
export function orientFromHit(shape: string, face: number, hit: Vec3, sneak: boolean): number {
  // Shapes that hang (arches) would swap the up and down sides; none of ours do.
  let side: number;
  if (face === 1) side = 0;
  else if (face === 0) side = 1;
  else if (sneak) side = face ^ 1;
  else side = hit[1] > 0 ? 1 : 0;
  return archSlot(side, turnForHit(side, hit, ARCH_SYMMETRY[shape] ?? "bi"));
}

/**
 * The slot an architecture shape takes when placed against `face` (the clicked face's outward
 * side) of a neighbour. `hit` is the click relative to the NEW cell's centre. `sneak` puts the
 * base against the clicked face (a stair on its side) and skips neighbour matching. `neighbor`
 * is the clicked cell's architecture part: lining up with it wins when their profiles match,
 * continuing a roof line.
 */
export function orientOnPlacement(
  shape: string,
  face: number,
  hit: Vec3,
  sneak: boolean,
  neighbor: { readonly shape: string; readonly slot: number } | null,
): number {
  if (!sneak && neighbor && neighbor.shape in ARCH_SHAPES) {
    const nside = (neighbor.slot % 24) >> 2;
    const nturn = neighbor.slot & 3;
    const other = profileGlobal(neighbor.shape, nside, nturn, face);
    if (other !== "") {
      for (let i = 0; i < 4; i++) {
        const turn = (nturn + i) & 3;
        if (profilesMatch(profileGlobal(shape, nside, turn, face ^ 1), other)) {
          return archSlot(nside, turn);
        }
      }
    }
  }
  return orientFromHit(shape, face, hit, sneak);
}

// --- Resolving a click ---

/** Where a click would put a part: the cell, and the slot in it. */
export interface PartPlacement {
  readonly cell: Vec3;
  readonly slot: number;
}

/** What the placement needs to know about the world. */
export interface PlacementWorld {
  /** The parts in a cell: [] for an empty cell, null when it holds a whole block. */
  parts(cell: Vec3): readonly RulePart[] | null;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * Where a part of `shape` (for `semantic`) lands for a click on `side` of `hitCell` at `vhit`,
 * or null when nothing fits. A click on a full block's face places into the neighbouring cell. A
 * click on the inner face of a thin part (hit depth < 1) places into that same cell when it
 * fits ("internal" placement), and otherwise falls back the way FMP does.
 */
export function resolvePlacement(
  world: PlacementWorld,
  semantic: unknown,
  shape: string,
  hitCell: Vec3,
  vhit: Vec3,
  side: number,
  opposite: boolean,
): PartPlacement | null {
  if (side < 0 || side > 5) return null;
  const sideVec = SIDE_VECTORS[side] as Vec3;
  const outside = add(hitCell, sideVec);
  const attempt = (cell: Vec3, slot: number): PartPlacement | null => {
    const existing = world.parts(cell);
    if (existing === null) return null;
    return rejectPart(existing, { semantic, shape, slot }) === null ? { cell, slot } : null;
  };

  if (isExclusive(shape)) {
    // Always into the cell beside the clicked face, oriented from where on the face you clicked.
    const hit: Vec3 = [
      vhit[0] - sideVec[0] - 0.5,
      vhit[1] - sideVec[1] - 0.5,
      vhit[2] - sideVec[2] - 0.5,
    ];
    const here = world.parts(hitCell);
    const only = here?.length === 1 ? here[0] : undefined;
    const neighbor = only && isExclusive(only.shape) ? only : null;
    return attempt(outside, orientOnPlacement(shape, side, hit, opposite, neighbor));
  }

  const micro = MICRO_SHAPES[shape] as MicroShape | undefined;
  if (!micro) return null;
  const hitParts = world.parts(hitCell);
  const intoParts = hitParts !== null && hitParts.length > 0;
  const depth =
    vhit[0] * sideVec[0] + vhit[1] * sideVec[1] + vhit[2] * sideVec[2] + ((side % 2) ^ 1);
  const internal = intoParts && depth < 1 - EPS;
  const slot = hitSlot(shape, vhit, side);

  if (slot < 0) {
    // The face's centre zone: only even-size edge pieces (Post, Pillar) have a centred form,
    // a post running along the clicked face's axis.
    if (micro.family !== "edge" || micro.size % 2 !== 0) return null;
    const postSlot = CENTER_SLOT + (side >> 1);
    return internal && !opposite ? attempt(hitCell, postSlot) : attempt(outside, postSlot);
  }

  const farSlot = oppositeSlot(shape, slot, side);
  const flips = usesOpposite(shape, slot, side);
  if (internal) {
    if (depth < 0.5 || !flips) {
      const here = attempt(hitCell, slot);
      if (here) {
        return !flips || !opposite ? here : attempt(hitCell, farSlot);
      }
    }
    if (flips && !opposite) return attempt(hitCell, farSlot);
    return attempt(outside, slot);
  }
  return attempt(outside, flips && opposite ? farSlot : slot);
}

/**
 * The lines of a shape's placement zones on a face, as u1 v1 u2 v2 per segment with u and v in
 * -0.5..0.5 across the face (u along side (side + 2) % 6, v along (side + 4) % 6): the border
 * and where a click on the face changes which slot a part takes. Architecture shapes orient
 * from the click and have no zones, so they give none.
 */
export function placementGrid(shape: string): Float32Array {
  const info = MICRO_SHAPES[shape];
  if (!info) return new Float32Array(0);
  const lines: number[] = [];
  const seg = (a: number, b: number, c: number, d: number) => lines.push(a, b, c, d);
  seg(-0.5, -0.5, 0.5, -0.5);
  seg(0.5, -0.5, 0.5, 0.5);
  seg(0.5, 0.5, -0.5, 0.5);
  seg(-0.5, 0.5, -0.5, -0.5);
  switch (info.family) {
    case "face":
    case "hollow": {
      const s = info.family === "face" ? 0.25 : 0.375;
      for (const [cx, cy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        seg(cx * 0.5, cy * 0.5, cx * s, cy * s);
      }
      seg(-s, -s, s, -s);
      seg(s, -s, s, s);
      seg(s, s, -s, s);
      seg(-s, s, -s, -s);
      break;
    }
    case "corner":
      seg(0, -0.5, 0, 0.5);
      seg(-0.5, 0, 0.5, 0);
      break;
    case "edge":
      for (const k of [-0.25, 0.25]) {
        seg(k, -0.5, k, 0.5);
        seg(-0.5, k, 0.5, k);
      }
      break;
  }
  return new Float32Array(lines);
}
