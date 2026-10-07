// Which of a block's blockstate variants a cell shows. A cell holds one of the 24 rotations of
// the cube (core rotation.ts): the turn from a model facing north with its top up. Minecraft
// blocks express the same thing as properties (facing, half, axis, ...), each variant naming
// a model and quarter turns. A block's identity variant is the one facing north, upright,
// with other properties at their plain defaults; a turned cell shows the variant whose
// properties face and stand the way the cell does.

import {
  compose,
  matrixOf,
  type Rotation,
  rotate,
  turn,
  turnClockwise,
  type Vec3,
} from "@voxyl/core";
import type { Block, Condition, Variant } from "./library.ts";

/** Properties that orient a block; every other property is matched to the identity's. */
const ORIENTATION = new Set(["facing", "half", "type", "axis", "face"]);

/** Preferred values: the identity variant's, and plain defaults for everything else. */
const PREFERRED: Readonly<Record<string, readonly string[]>> = {
  facing: ["north"],
  half: ["bottom", "lower"],
  type: ["bottom", "single"],
  axis: ["y"],
  face: ["floor"],
  shape: ["straight", "north_south"],
};
const PLAIN = new Set(["false", "none", "0", "low", "side"]);

const DIRECTION: Readonly<Record<string, Vec3>> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};
const AXIS: Readonly<Record<string, Vec3>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function parseProps(key: string): Record<string, string> {
  const props: Record<string, string> = {};
  if (key === "" || key === "normal") return props;
  for (const pair of key.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) props[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return props;
}

/** The turn a variant gives its model: Minecraft's x turn, then its y turn. */
export function variantRotation(variant: Variant): Rotation {
  // Minecraft turns clockwise looking from the positive end of each axis: y = 90 takes east
  // to south, x = 270 takes a north-facing model's front up.
  const x = turn(0, -(variant.x ?? 0) / 90);
  return compose(turnClockwise((variant.y ?? 0) / 90), x);
}

/** A model to draw, turned into place. */
export interface PlacedModel {
  readonly model: string;
  /** The turn from the model's own space into the world. */
  readonly rotation: Rotation;
  readonly uvlock: boolean;
}

interface VariantTable {
  /** The variant key each of the 24 rotations shows. */
  readonly byRotation: readonly string[];
}

const tables = new WeakMap<Block, VariantTable>();

/** The variant a cell turned by `rotation` shows, or null for a multipart-only block. */
export function variantFor(block: Block, rotation: Rotation): Variant | null {
  const variants = block.variants;
  if (!variants) return null;
  let table = tables.get(block);
  if (!table) {
    table = buildTable(variants);
    tables.set(block, table);
  }
  const key = table.byRotation[rotation] ?? table.byRotation[0] ?? "";
  return variants[key] ?? Object.values(variants)[0] ?? null;
}

/**
 * The models a block draws for a cell. `props` holds properties the cell's surroundings
 * decide (a fence's "north": "true"), for multipart blocks; anything unset is "false".
 */
export function placeBlock(
  block: Block,
  rotation: Rotation,
  props: Readonly<Record<string, string>> = {},
): PlacedModel[] {
  const out: PlacedModel[] = [];
  const add = (v: Variant) =>
    out.push({ model: v.model, rotation: variantRotation(v), uvlock: v.uvlock ?? false });
  const variant = variantFor(block, rotation);
  if (variant) add(variant);
  for (const part of block.multipart ?? []) {
    if (!part.when || matches(part.when, props)) add(part.apply);
  }
  return out;
}

/** Whether a multipart condition holds for these properties (unset ones read "false"). */
export function matches(when: Condition, props: Readonly<Record<string, string>>): boolean {
  if ("OR" in when && Array.isArray(when.OR))
    return (when.OR as Condition[]).some((c) => matches(c, props));
  if ("AND" in when && Array.isArray(when.AND))
    return (when.AND as Condition[]).every((c) => matches(c, props));
  return Object.entries(when as Record<string, string>).every(([name, values]) =>
    values.split("|").includes(props[name] ?? "false"),
  );
}

function buildTable(variants: Readonly<Record<string, Variant>>): VariantTable {
  const keys = Object.keys(variants);
  const parsed = keys.map((key) => ({ key, props: parseProps(key) }));
  // The identity: fewest properties away from their preferred values; ties go to file order.
  const penalty = (props: Record<string, string>) =>
    Object.entries(props).reduce((sum, [name, value]) => {
      const preferred = PREFERRED[name];
      if (preferred) return sum + (preferred.includes(value) ? 0 : 1);
      return sum + (PLAIN.has(value) ? 0 : 1);
    }, 0);
  let identity = parsed[0];
  for (const p of parsed) if (identity && penalty(p.props) < penalty(identity.props)) identity = p;
  // Only variants that differ from the identity in orientation take part.
  const candidates = parsed.filter((p) =>
    Object.entries(p.props).every(
      ([name, value]) => ORIENTATION.has(name) || identity?.props[name] === value,
    ),
  );
  const byRotation: string[] = [];
  for (let r = 0; r < 24; r++) {
    const front = rotate(r, [0, 0, -1]);
    const up = rotate(r, [0, 1, 0]);
    let best = identity?.key ?? "";
    let bestScore = -1;
    for (const c of candidates) {
      const score = scoreFor(c.props, front, up);
      if (score > bestScore) {
        best = c.key;
        bestScore = score;
      }
    }
    byRotation.push(best);
  }
  return { byRotation };
}

/** How well a variant's properties match a cell's front and top. */
function scoreFor(props: Record<string, string>, front: Vec3, up: Vec3): number {
  let score = 0;
  const facing = props.facing ? DIRECTION[props.facing] : undefined;
  if (facing) score += same(facing, front) ? 8 : 0;
  const upsideDown = props.half === "top" || props.half === "upper" || props.type === "top";
  if (props.half !== undefined || props.type !== undefined)
    score += same(upsideDown ? [0, -1, 0] : [0, 1, 0], up) ? 4 : 0;
  const axis = props.axis ? AXIS[props.axis] : undefined;
  if (axis) score += Math.abs(dot(axis, up)) === 1 ? 8 : 0;
  if (props.face === "ceiling") score += same([0, -1, 0], up) ? 4 : 0;
  if (props.face === "floor") score += same([0, 1, 0], up) ? 4 : 0;
  return score;
}

const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Applies a rotation to a point of a cell in sixteenths, turning about the cell's centre. */
export function rotatePoint16(r: Rotation, p: readonly [number, number, number]): Vec3 {
  const m = matrixOf(r);
  const c = [p[0] - 8, p[1] - 8, p[2] - 8];
  const at = (row: number) =>
    (m[row * 3] ?? 0) * (c[0] ?? 0) +
    (m[row * 3 + 1] ?? 0) * (c[1] ?? 0) +
    (m[row * 3 + 2] ?? 0) * (c[2] ?? 0) +
    8;
  return [at(0), at(1), at(2)];
}
