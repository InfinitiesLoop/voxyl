// Blocks that aren't one whole cube (slabs, stairs, fences, panes, plants) as the faces of
// their models, placed in the cell for one cell rotation: each face's corners in sixteenths
// of the cell and its texture. Blocks that join their neighbours (fences, panes, walls) get
// one set of faces per combination of joined sides, which the mesher picks per cell.

import type { Rotation } from "@voxyl/core";
import type { CompiledFace, Libraries } from "./compile.ts";
import {
  type Block,
  type Condition,
  type Library,
  MC_SIDES,
  type McSide,
  parseBlockRef,
} from "./library.ts";
import { elementTurn, FACE_SIDES, faceUvMap } from "./uv.ts";
import { placeBlock, rotatePoint16 } from "./variants.ts";

type Point = readonly [number, number, number];

export interface ShapeFace {
  /** Corners in sixteenths of the cell (world axes, 0..16), counter-clockwise from outside. */
  readonly corners: readonly [Point, Point, Point, Point];
  /** The world side it faces when axis-aligned; null for a face turned off the axes. */
  readonly side: McSide | null;
  readonly face: CompiledFace;
}

/** Join groups: what a joining block is, and which of them it joins (JOIN_* bits). */
export const JOIN_FENCE = 1;
export const JOIN_PANE = 2;
export const JOIN_WALL = 4;

/** The sides a joining block's mask counts, bit 0 first: north, east, south, west. */
export const JOIN_SIDES = ["north", "east", "south", "west"] as const;

export interface CompiledShape {
  /**
   * The faces to draw: one set, or for a block that joins its neighbours 16, by the mask of
   * sides it joins (JOIN_SIDES bits). A side joins a whole cube, or a block whose `group`
   * is in this one's `joins`.
   */
  readonly variants: readonly (readonly ShapeFace[])[];
  readonly group: number;
  readonly joins: number;
  /**
   * For each world side in the mesher's order (+X, -X, +Y, -Y, +Z, -Z), the face this block
   * shows that way (its largest), for shaped parts drawn in its look; null where it has none.
   */
  readonly sides: readonly (CompiledFace | null)[];
}

/** Each side's normal axis and sign, and the in-plane axes U and V (the mesher's FACES). */
const SIDE_AXES: Readonly<Record<McSide, readonly [number, number, number, number]>> = {
  east: [0, 1, 1, 2],
  west: [0, -1, 2, 1],
  up: [1, 1, 2, 0],
  down: [1, -1, 0, 2],
  south: [2, 1, 0, 1],
  north: [2, -1, 1, 0],
};

const cache = new WeakMap<Library, Map<string, CompiledShape>>();

/**
 * The faces of the block a look names, for a cell rotation, or null if no library has it.
 * Meant for blocks compileBlock finds no whole cube for; a whole cube compiles too.
 */
export function compileShape(
  libraries: Libraries,
  ref: string,
  rotation: Rotation,
): CompiledShape | null {
  const parsed = parseBlockRef(ref);
  const library = parsed ? libraries.get(parsed.library) : undefined;
  const block = parsed && library ? library.blocks[parsed.block] : undefined;
  if (!parsed || !library || !block) return null;
  let compiled = cache.get(library);
  if (!compiled) {
    compiled = new Map();
    cache.set(library, compiled);
  }
  const key = `${parsed.block}@${rotation}`;
  const hit = compiled.get(key);
  if (hit) return hit;

  const facesFor = (props: Readonly<Record<string, string>>): ShapeFace[] => {
    const out: ShapeFace[] = [];
    for (const placed of placeBlock(block, rotation, props)) {
      for (const element of library.models[placed.model]?.elements ?? []) {
        const turn = elementTurn(element);
        for (const side of MC_SIDES) {
          const face = element.faces[side];
          const texture = face ? library.textures[face.texture] : undefined;
          if (!face || !texture) continue;
          const [axis, sign, u, v] = SIDE_AXES[side];
          const plane = sign > 0 ? element.to[axis] : element.from[axis];
          const corner = (cu: readonly number[], cv: readonly number[]): Point => {
            const p = [0, 0, 0];
            p[axis] = plane ?? 0;
            p[u] = cu[u] ?? 0;
            p[v] = cv[v] ?? 0;
            const [x, y, z] = rotatePoint16(placed.rotation, turn.forward(p));
            return [clamp16(x), clamp16(y), clamp16(z)];
          };
          const { from, to } = element;
          const corners = [
            corner(from, from),
            corner(to, from),
            corner(to, to),
            corner(from, to),
          ] as const;
          if (area(corners) < 1e-6) continue;
          out.push({
            corners,
            side: turn.turns ? null : worldSide(corners),
            face: {
              texture: `${library.id}:${face.texture}`,
              alpha: texture.alpha,
              tint: face.tint ?? null,
              map: faceUvMap(element, side, face, placed.rotation, placed.uvlock),
            },
          });
        }
      }
    }
    return out;
  };
  const joining = joinProps(block, parsed.block);
  const variants = joining
    ? Array.from({ length: 16 }, (_, mask) => facesFor(joining.props(mask)))
    : [facesFor({})];
  const result: CompiledShape = {
    variants,
    group: joining?.group ?? 0,
    joins: joining?.joins ?? 0,
    sides: sidesOf(variants[0] ?? []),
  };
  compiled.set(key, result);
  return result;
}

/** Within the cell, and rounded so whole sixteenths stay whole after turning. */
const clamp16 = (c: number) => Math.min(16, Math.max(0, Math.round(c * 1e4) / 1e4));

function area(c: readonly Point[]): number {
  const [a, b, d] = [c[0], c[1], c[3]] as [Point, Point, Point];
  const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const f = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const x = (e[1] ?? 0) * (f[2] ?? 0) - (e[2] ?? 0) * (f[1] ?? 0);
  const y = (e[2] ?? 0) * (f[0] ?? 0) - (e[0] ?? 0) * (f[2] ?? 0);
  const z = (e[0] ?? 0) * (f[1] ?? 0) - (e[1] ?? 0) * (f[0] ?? 0);
  return Math.hypot(x, y, z);
}

/** The side an axis-aligned face looks toward, from its corners' winding. */
function worldSide(c: readonly Point[]): McSide {
  const [a, b, d] = [c[0], c[1], c[3]] as [Point, Point, Point];
  const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const f = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const n = [
    (e[1] ?? 0) * (f[2] ?? 0) - (e[2] ?? 0) * (f[1] ?? 0),
    (e[2] ?? 0) * (f[0] ?? 0) - (e[0] ?? 0) * (f[2] ?? 0),
    (e[0] ?? 0) * (f[1] ?? 0) - (e[1] ?? 0) * (f[0] ?? 0),
  ];
  const axis = [0, 1, 2].reduce((best, k) =>
    Math.abs(n[k] ?? 0) > Math.abs(n[best] ?? 0) ? k : best,
  );
  const positive = (n[axis] ?? 0) > 0;
  return (
    [
      ["east", "west"],
      ["up", "down"],
      ["south", "north"],
    ] as const
  )[axis]?.[positive ? 0 : 1] as McSide;
}

function sidesOf(faces: readonly ShapeFace[]): (CompiledFace | null)[] {
  return FACE_SIDES.map((side) => {
    let best: ShapeFace | null = null;
    let bestArea = 0;
    for (const f of faces) {
      const a = area(f.corners);
      if (f.side === side && a > bestArea) {
        best = f;
        bestArea = a;
      }
    }
    return best?.face ?? null;
  });
}

/**
 * How a multipart block reads its joined sides: the properties for a mask of joined sides,
 * and its join group. Null for blocks whose conditions name no side.
 */
function joinProps(
  block: Block,
  name: string,
): { props: (mask: number) => Record<string, string>; group: number; joins: number } | null {
  const values = new Map<string, Set<string>>();
  const visit = (when: Condition) => {
    if ("OR" in when && Array.isArray(when.OR)) for (const c of when.OR as Condition[]) visit(c);
    else if ("AND" in when && Array.isArray(when.AND))
      for (const c of when.AND as Condition[]) visit(c);
    else
      for (const [prop, value] of Object.entries(when as Record<string, string>)) {
        const set = values.get(prop) ?? new Set<string>();
        for (const v of value.split("|")) set.add(v);
        values.set(prop, set);
      }
  };
  for (const part of block.multipart ?? []) if (part.when) visit(part.when);
  if (!JOIN_SIDES.some((side) => values.has(side))) return null;
  const group = /_wall$/.test(name)
    ? JOIN_WALL
    : /(^|_)pane$|^iron_bars$/.test(name)
      ? JOIN_PANE
      : /_fence$/.test(name)
        ? JOIN_FENCE
        : 0;
  const joins = group === JOIN_FENCE ? JOIN_FENCE : group ? JOIN_PANE | JOIN_WALL : 0;
  const tall = group === JOIN_WALL && values.has("up");
  return {
    group,
    joins,
    props: (mask) => {
      const props: Record<string, string> = {};
      JOIN_SIDES.forEach((side, bit) => {
        const known = values.get(side);
        if (!known) return;
        const on = known.has("low") ? "low" : "true";
        const off = known.has("none") ? "none" : "false";
        props[side] = mask & (1 << bit) ? on : off;
      });
      // A wall drops its post where it runs straight through (north-south or east-west).
      if (tall) props.up = mask === 5 || mask === 10 ? "false" : "true";
      return props;
    },
  };
}
