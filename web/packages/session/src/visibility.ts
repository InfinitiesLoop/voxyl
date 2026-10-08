// What a view chooses not to see: a cutaway (a box of cells hidden, to see and build inside) and
// isolation (only a box shown). Hidden cells are not drawn and are not hit by a ray, and their
// neighbours show the faces that were buried, so the cut looks like a cut and not like a hole in
// a hollow shell. It is a lens (CLAUDE.md principle 2): the cells themselves never change.
//
// The mesher reads the cells a chunk's job copied, so hiding is done to that copy: cells that
// are hidden read as empty. Light is not touched, so a cut surface is lit as it was.

import { EMPTY_ID } from "@voxyl/core";

/** A box of cells, both corners inclusive. */
export interface CellBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface Visibility {
  /** Cells in this box are hidden. */
  readonly hide: CellBox | null;
  /** When set, only cells in this box are shown. */
  readonly only: CellBox | null;
}

export const SHOW_ALL: Visibility = { hide: null, only: null };

export function sameBox(a: CellBox | null, b: CellBox | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.min.every((v, i) => v === b.min[i]) && a.max.every((v, i) => v === b.max[i]);
}

export function sameVisibility(a: Visibility, b: Visibility): boolean {
  return sameBox(a.hide, b.hide) && sameBox(a.only, b.only);
}

export function inBox(box: CellBox, x: number, y: number, z: number): boolean {
  return (
    x >= box.min[0] &&
    x <= box.max[0] &&
    y >= box.min[1] &&
    y <= box.max[1] &&
    z >= box.min[2] &&
    z <= box.max[2]
  );
}

/** Whether a cell is hidden: inside the cutaway, or outside the isolated box. */
export function isHidden(v: Visibility, x: number, y: number, z: number): boolean {
  if (v.only && !inBox(v.only, x, y, z)) return true;
  return v.hide !== null && inBox(v.hide, x, y, z);
}

/** The padded cells of a chunk's mesh job, with the hidden ones made empty. */
export function maskPadded(
  cells: Uint16Array,
  v: Visibility,
  chunk: readonly [number, number, number],
  bits: number,
): void {
  if (v.hide === null && v.only === null) return;
  const S = 1 << bits;
  const P = S + 2;
  const ox = chunk[0] * S - 1;
  const oy = chunk[1] * S - 1;
  const oz = chunk[2] * S - 1;
  for (let py = 0; py < P; py++) {
    for (let pz = 0; pz < P; pz++) {
      for (let px = 0; px < P; px++) {
        const at = px + pz * P + py * P * P;
        if (cells[at] !== EMPTY_ID && isHidden(v, ox + px, oy + py, oz + pz)) cells[at] = EMPTY_ID;
      }
    }
  }
}

/** Whether a chunk's cells, with one cell around them, meet a box. */
export function chunkMeets(
  box: CellBox,
  chunk: readonly [number, number, number],
  bits: number,
): boolean {
  const S = 1 << bits;
  for (let a = 0; a < 3; a++) {
    const lo = (chunk[a] ?? 0) * S - 1;
    const hi = lo + S + 1;
    if (box.max[a] === undefined || (box.max[a] as number) < lo || (box.min[a] as number) > hi) {
      return false;
    }
  }
  return true;
}
