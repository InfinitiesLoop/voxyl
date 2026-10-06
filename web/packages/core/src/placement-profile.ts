// Placement profiles (web-core.md, section 3): how a semantic may be oriented, as data. There is
// no per-block code anywhere: a profile says which of the 24 rotations are allowed, which look
// the same, and how a click picks one, from rules Minecraft players know.
//
// A profile is intent, so it lives on the semantic's form (a semantic shaped like stairs places
// like stairs whatever block it maps to, and undecided semantics place sensibly). When block
// libraries arrive, a mapped block can supply one too, for semantics whose form doesn't.
//
// Cells store rotations in canonical form: of the rotations that look the same, the smallest.
// Identical-looking cells therefore share one state, and a turned plain cube stays one state.

import { z } from "zod";
import {
  canonical,
  compose,
  facingOf,
  IDENTITY,
  inverse,
  matrixOf,
  ROTATION_COUNT,
  type Rotation,
  rotationFacing,
  SYMMETRY,
  stabilizer,
  upOf,
  type Vec3,
} from "./rotation.ts";

/** The six directions, as profiles and the text codec name them. */
export const SIDES = ["north", "east", "south", "west", "up", "down"] as const;
export type Side = (typeof SIDES)[number];
export const SideArg = z.enum(SIDES);

export const SIDE_VECTORS: Readonly<Record<Side, Vec3>> = {
  north: [0, 0, -1],
  east: [1, 0, 0],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};

/** The side a unit axis vector points to. */
export function sideOf(v: Vec3): Side {
  const found = SIDES.find((s) => sameVec(SIDE_VECTORS[s], v));
  if (!found) throw new RangeError(`[${v}] isn't a unit axis vector`);
  return found;
}

/**
 * Which rotations look the same, named by what a model is symmetric about:
 * - `none`: every rotation looks different (stairs)
 * - `all`: rotation doesn't matter (a plain cube)
 * - `spin`: spinning about its own up axis changes nothing (a torch, a slab)
 * - `spin_front`: spinning about its front axis changes nothing (a dispenser, a hopper)
 * - `axis`: only the line its up axis lies along matters (a log, a pillar)
 */
export const SYMMETRIES = ["none", "all", "spin", "spin_front", "axis"] as const;
export type SymmetryName = (typeof SYMMETRIES)[number];

/**
 * How a click picks a rotation. `face` is the clicked face's outward normal (the new cell
 * sits on that side of the block clicked), and the player is where the view comes from:
 * - `fixed`: no rotation (as close to it as the profile allows)
 * - `face_player`: the front points at the player (stairs, furnaces, pistons)
 * - `face_look`: the front points where the player looks (observers)
 * - `away_from_face`: the front points away from the face clicked (end rods)
 * - `into_face`: the front points into the block clicked (hoppers)
 * - `attach`: the top points away from the face clicked: the block hangs on it (torches, logs)
 */
export const PICKS = [
  "fixed",
  "face_player",
  "face_look",
  "away_from_face",
  "into_face",
  "attach",
] as const;
export type PickRule = (typeof PICKS)[number];

export interface PlacementProfile {
  /** Where the model's front (-Z) may point. Default: anywhere. */
  readonly front?: readonly Side[];
  /** Where the model's top (+Y) may point. Default: anywhere. */
  readonly up?: readonly Side[];
  /** Which rotations look the same. Default `none`. */
  readonly symmetry?: SymmetryName;
  /** How a click picks a rotation. Default `fixed`. */
  readonly pick?: PickRule;
  /** Upside down when the click hits a block's underside or the upper half of its side. */
  readonly flip?: boolean;
}

/** A click, as the editor sees it, for picking a rotation. */
export interface Click {
  /** The clicked face's outward normal: a unit axis vector. */
  readonly face: Vec3;
  /** The direction the player looks (any length). */
  readonly look: Vec3;
  /** Where on the clicked face the click landed, 0 (bottom) to 1 (top); sides only. */
  readonly hitY?: number;
}

/**
 * Common profiles, for editors and importers to start from. Cells never refer to these by
 * name: a semantic's form holds the profile itself, so changing this table changes no build.
 */
export const PLACEMENTS = {
  cube: { symmetry: "all" },
  horizontal: { front: ["north", "east", "south", "west"], up: ["up"], pick: "face_player" },
  stairs: {
    front: ["north", "east", "south", "west"],
    up: ["up", "down"],
    pick: "face_player",
    flip: true,
  },
  slab: { up: ["up", "down"], symmetry: "spin", flip: true },
  log: { symmetry: "axis", pick: "attach" },
  facing: { symmetry: "spin_front", pick: "face_player" },
  torch: { up: ["up", "north", "east", "south", "west"], symmetry: "spin", pick: "attach" },
  hopper: {
    front: ["down", "north", "east", "south", "west"],
    symmetry: "spin_front",
    pick: "into_face",
  },
} as const satisfies Record<string, PlacementProfile>;

export const PlacementArg = z
  .strictObject({
    front: z.array(SideArg).min(1).optional(),
    up: z.array(SideArg).min(1).optional(),
    symmetry: z.enum(SYMMETRIES).optional(),
    pick: z.enum(PICKS).optional(),
    flip: z.boolean().optional(),
  })
  .transform(
    (p): PlacementProfile =>
      Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
  )
  .refine((p) => allowedMembers(p).length > 0, {
    message: "no rotation has its front and top where the profile allows",
  });

/** A profile ready to use: which rotations it allows, and how to fix and pick them. */
export interface CompiledPlacement {
  readonly profile: PlacementProfile;
  /** The allowed rotations in canonical form, ascending. */
  readonly allowed: readonly Rotation[];
  /** The symmetry group: r and r ∘ g look the same for every g in it. */
  readonly symmetry: readonly Rotation[];
  /** Whether a rotation is allowed (it, or one that looks the same, meets the profile). */
  allows(r: Rotation): boolean;
  /** The canonical allowed rotation nearest r (r's own canonical form if it is allowed). */
  fix(r: Rotation): Rotation;
  /** The rotation a click places. */
  pick(click: Click): Rotation;
  /**
   * For blocks that hang on what they were placed against (the `attach` rule): the side their
   * holder is on, opposite their top. Null for every other profile.
   */
  attachedTo(r: Rotation): Side | null;
}

const cache = new Map<string, CompiledPlacement>();

/** The compiled form of a profile (none = anything goes, nothing alike). Cached by content. */
export function compilePlacement(profile: PlacementProfile = {}): CompiledPlacement {
  const key = JSON.stringify([
    profile.front ? [...profile.front].sort() : null,
    profile.up ? [...profile.up].sort() : null,
    profile.symmetry ?? "none",
    profile.pick ?? "fixed",
    profile.flip ?? false,
  ]);
  let compiled = cache.get(key);
  if (!compiled) {
    compiled = compile(profile);
    cache.set(key, compiled);
  }
  return compiled;
}

function symmetryGroup(name: SymmetryName = "none"): readonly Rotation[] {
  switch (name) {
    case "none":
      return SYMMETRY.none;
    case "all":
      return SYMMETRY.all;
    case "axis":
      return SYMMETRY.axisY;
    case "spin":
      return stabilizer((r) => sameVec(upOf(r), [0, 1, 0]));
    case "spin_front":
      return stabilizer((r) => sameVec(facingOf(r), [0, 0, -1]));
  }
}

/** The rotations whose front and top meet the profile's constraints directly. */
function allowedMembers(profile: PlacementProfile): Rotation[] {
  const fronts = profile.front?.map((s) => SIDE_VECTORS[s]);
  const ups = profile.up?.map((s) => SIDE_VECTORS[s]);
  const out: Rotation[] = [];
  for (let r = 0; r < ROTATION_COUNT; r++) {
    if (fronts && !fronts.some((v) => sameVec(v, facingOf(r)))) continue;
    if (ups && !ups.some((v) => sameVec(v, upOf(r)))) continue;
    out.push(r);
  }
  return out;
}

function compile(profile: PlacementProfile): CompiledPlacement {
  const symmetry = symmetryGroup(profile.symmetry);
  const members = allowedMembers(profile);
  if (members.length === 0) throw new RangeError("A placement profile allows no rotation");
  const allowedSet = new Set(members.map((r) => canonical(r, symmetry)));
  const allowed = [...allowedSet].sort((a, b) => a - b);
  const fixTable = new Uint8Array(ROTATION_COUNT);
  for (let r = 0; r < ROTATION_COUNT; r++) {
    const own = canonical(r, symmetry);
    fixTable[r] = allowedSet.has(own) ? own : nearest(r, members, symmetry);
  }
  const pickRule = profile.pick ?? "fixed";
  const flip = profile.flip ?? false;
  return {
    profile,
    allowed,
    symmetry,
    allows: (r) => allowedSet.has(canonical(r, symmetry)),
    attachedTo(r) {
      if (pickRule !== "attach") return null;
      const [x, y, z] = upOf(r);
      return sideOf([-x, -y, -z]);
    },
    fix: (r) => fixTable[r] ?? IDENTITY,
    pick(click) {
      const look = normalize(click.look);
      const toPlayer: Vec3 = [-look[0], -look[1], -look[2]];
      const face = click.face;
      const flipped = flip && (face[1] < 0 || (face[1] === 0 && (click.hitY ?? 0) > 0.5));
      const wantUp: Vec3 = [0, flipped ? -1 : 1, 0];
      const score = (r: Rotation): number[] => {
        const front = facingOf(r);
        const up = upOf(r);
        const primary =
          pickRule === "face_player"
            ? dot(front, toPlayer)
            : pickRule === "face_look"
              ? dot(front, look)
              : pickRule === "away_from_face"
                ? dot(front, face)
                : pickRule === "into_face"
                  ? -dot(front, face)
                  : pickRule === "attach"
                    ? dot(up, face)
                    : 0;
        const facePlayer = pickRule === "face_look" ? 0 : dot(front, toPlayer);
        return [primary, dot(up, wantUp), facePlayer, -front[2] + up[1]];
      };
      let best = members[0] as Rotation;
      let bestScore = score(best);
      for (const r of members) {
        const s = score(r);
        if (better(s, bestScore)) {
          best = r;
          bestScore = s;
        }
      }
      return fixTable[best] ?? IDENTITY;
    },
  };
}

/**
 * The canonical form of the allowed rotation nearest r: the smallest angle between them (the
 * largest trace of a⁻¹ ∘ r), then the one keeping r's front, then its top, then the smallest.
 */
function nearest(r: Rotation, members: readonly Rotation[], symmetry: readonly Rotation[]) {
  let best = -1;
  let bestScore: number[] = [];
  for (const a of members) {
    for (const g of symmetry) {
      const m = matrixOf(compose(inverse(a), compose(r, g)));
      const s = [
        (m[0] ?? 0) + (m[4] ?? 0) + (m[8] ?? 0),
        dot(facingOf(a), facingOf(r)),
        dot(upOf(a), upOf(r)),
        -canonical(a, symmetry),
      ];
      if (best < 0 || better(s, bestScore)) {
        best = a;
        bestScore = s;
      }
    }
  }
  return canonical(best, symmetry);
}

/** The rotation whose front and top face these sides, with sensible defaults for the other. */
export function rotationOf(front?: Side, up?: Side): Rotation {
  if (front === undefined && up === undefined) return IDENTITY;
  if (front !== undefined && up !== undefined) {
    return rotationFacing(SIDE_VECTORS[front], SIDE_VECTORS[up]);
  }
  if (front !== undefined) {
    // Upright when facing sideways; tipped forward or back from north when facing up or down.
    const top: Side = front === "up" ? "south" : front === "down" ? "north" : "up";
    return rotationFacing(SIDE_VECTORS[front], SIDE_VECTORS[top]);
  }
  // Front north when the top is up or down; tipped so the front points down otherwise.
  const u = up as Side;
  const f: Side = u === "up" || u === "down" ? "north" : "down";
  return rotationFacing(SIDE_VECTORS[f], SIDE_VECTORS[u]);
}

function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d > 1e-9) return true;
    if (d < -1e-9) return false;
  }
  return false;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
