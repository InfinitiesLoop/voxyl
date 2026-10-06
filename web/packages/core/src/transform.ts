// Moving cells between places and frames: turns, mirrors and "north is north" (web-core.md,
// sections 3 and 9). A placement is a quarter-turn about Y, clockwise seen from above, then an
// optional mirror, as building tools mean them. Positions move by the placement's matrix, and
// so does what each cell holds: a whole block's rotation composes with it, and each part's
// slot moves to the slot its geometry lands in (packages/shapes).
//
// Every frame cells live in has a north: a project, a prefab, the clipboard (the project it was
// cut from) and an exported file. The cells are never rewritten when a project's north changes;
// moving cells between frames turns them by turnsBetween, so north stays the real north.

import { type CellMatrix, transformSlot } from "@voxyl/shapes";
import { z } from "zod";
import { type Box, unionBox } from "./box.ts";
import { type CellStateInput, type CellStateTable, EMPTY_ID } from "./cell-state.ts";
import { determinant, matrixOf, transformRotation, turnClockwise, type Vec3 } from "./rotation.ts";

/** The compass directions, clockwise from north, as a frame's own axes name them. */
export const DIRECTIONS = ["north", "east", "south", "west"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const DirectionArg = z.enum(DIRECTIONS);

/**
 * Quarter turns clockwise that carry cells from a frame whose real north is `from` into one
 * whose real north is `to`, so north stays north. "east" means the frame's +X points north.
 */
export function turnsBetween(from: Direction, to: Direction): number {
  return (((DIRECTIONS.indexOf(to) - DIRECTIONS.indexOf(from)) % 4) + 4) % 4;
}

export type MirrorAxis = "x" | "y" | "z";

/** A turn and mirror as commands take them. */
export const PlacementArgs = {
  /** Quarter turns clockwise seen from above. */
  turn: z.number().int().min(-3).max(3).optional(),
  /** Mirror across the plane normal to this axis, after turning ("x" swaps east and west). */
  mirror: z.enum(["x", "y", "z"]).optional(),
};

/** The matrix (row-major, signed permutation) of `turn` quarter turns clockwise, then a mirror. */
export function placementMatrix(turn = 0, mirror?: MirrorAxis): number[] {
  const m = matrixOf(turnClockwise(turn));
  if (mirror === undefined) return m;
  const row = mirror === "x" ? 0 : mirror === "y" ? 1 : 2;
  for (let c = 0; c < 3; c++) m[row * 3 + c] = -(m[row * 3 + c] ?? 0);
  return m;
}

export function applyMatrix(m: readonly number[], v: Vec3): Vec3 {
  const [x, y, z] = v;
  return [
    (m[0] ?? 0) * x + (m[1] ?? 0) * y + (m[2] ?? 0) * z,
    (m[3] ?? 0) * x + (m[4] ?? 0) * y + (m[5] ?? 0) * z,
    (m[6] ?? 0) * x + (m[7] ?? 0) * y + (m[8] ?? 0) * z,
  ];
}

export function isIdentityMatrix(m: readonly number[]): boolean {
  return m.every((v, i) => v === (i % 4 === 0 ? 1 : 0));
}

/** Where `box` lands under `m` (about the origin): the box around its moved corners. */
export function movedBox(box: Box, m: readonly number[]): Box {
  let out: Box | null = null;
  for (const [x, y, z] of [
    [box.x0, box.y0, box.z0],
    [box.x1, box.y1, box.z1],
  ] as const) {
    const [a, b, c] = applyMatrix(m, [x, y, z]);
    out = unionBox(out, { x0: a, y0: b, z0: c, x1: a, y1: b, z1: c });
  }
  return out as Box;
}

/**
 * Moves cell states by a placement matrix, interning what they become. A whole block's new
 * rotation goes through `fix` (its semantic's placement profile, see Project.placement).
 * Memoized per state id, so a million cells of a dozen states cost a dozen lookups.
 */
export class StateMover {
  readonly #table: CellStateTable;
  readonly #m: CellMatrix;
  readonly #identity: boolean;
  readonly #memo = new Map<number, number | null>();
  readonly #fix: (semantic: number, rotation: number) => number;

  constructor(
    table: CellStateTable,
    m: readonly number[],
    fix: (semantic: number, rotation: number) => number = (_, r) => r,
  ) {
    this.#table = table;
    this.#m = m;
    this.#identity = isIdentityMatrix(m);
    this.#fix = fix;
    if (Math.abs(determinant(m)) !== 1) throw new RangeError("Not a placement matrix");
  }

  /**
   * The id a state becomes, or null when a part has no image under the placement (a chiral
   * shape mirrored, or a shape with no known geometry): such a cell can't be placed exactly.
   */
  move(id: number): number | null {
    if (id === EMPTY_ID || this.#identity) return id;
    let out = this.#memo.get(id);
    if (out === undefined) {
      out = this.#compute(id);
      this.#memo.set(id, out);
    }
    return out;
  }

  #compute(id: number): number | null {
    const state = this.#table.get(id);
    if (!state) return id;
    if (state.parts.length === 0) {
      return this.#table.intern({
        semantic: state.semantic,
        rotation: this.#fix(state.semantic, transformRotation(state.rotation, this.#m)),
        tags: state.tags,
      });
    }
    // A cell of parts is oriented by its parts' slots; its own rotation is left as it is.
    const parts: NonNullable<CellStateInput["parts"]>[number][] = [];
    for (const p of state.parts) {
      const slot = transformSlot(p.shape, p.slot, this.#m);
      if (slot === null) return null;
      parts.push({ semantic: p.semantic, shape: p.shape, slot });
    }
    return this.#table.intern({ rotation: state.rotation, tags: state.tags, parts });
  }
}
