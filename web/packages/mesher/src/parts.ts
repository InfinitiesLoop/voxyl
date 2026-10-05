// What the mesher knows about each cell state: empty, a whole cube, or shaped parts with
// their geometry. Part geometry is built once per state and reused for every cell that holds
// it, so meshing a part cell is a table lookup plus neighbour culling.

import type { CellStateTable } from "@voxyl/core";
import { archTriangles, MICRO_SHAPES, microBoxes } from "@voxyl/shapes";
import { FACES } from "./faces.ts";

/** Triangle corners are stored in 1/TRI_SCALE of a cell: exact for halves, thirds, quarters and sixteenths. */
export const TRI_SCALE = 48;

/** One part of a shaped state, with the plain state id that colours it (its semantic's). */
export interface PartShape {
  readonly shape: string;
  readonly slot: number;
  readonly color: number;
}

/** What the mesher needs to know about one cell state. Plain data, so it can go to workers. */
export type StateShape =
  | { readonly kind: "empty" }
  | { readonly kind: "cube" }
  | { readonly kind: "parts"; readonly parts: readonly PartShape[] };

/**
 * Describes states `from` to the end of `states`. Each part is coloured by the plain state of
 * its semantic, which this interns if the world doesn't have it yet, so it can grow `states`
 * (the new states are described too). Shapes the catalog doesn't know draw as a whole cube.
 */
export function describeStates(states: CellStateTable, from = 1): StateShape[] {
  const out: StateShape[] = [];
  for (let id = Math.max(from, 1); id <= states.size; id++) {
    const state = states.get(id);
    const known = (state?.parts ?? []).filter((p) => isKnownShape(p.shape));
    if (!state || known.length === 0) {
      out.push({ kind: "cube" });
      continue;
    }
    out.push({
      kind: "parts",
      parts: known.map((p) => ({
        shape: p.shape,
        slot: p.slot,
        color: states.intern({ semantic: p.semantic }),
      })),
    });
  }
  return out;
}

function isKnownShape(shape: string): boolean {
  return shape in MICRO_SHAPES || archTriangles(shape, 0).length > 0;
}

/** RECT_STRIDE numbers per rectangle: face, plane, u0, v0, u1, v1, colour (eighths of a cell). */
export const RECT_STRIDE = 7;
/**
 * TRI_STRIDE numbers per triangle: 9 corner coordinates (TRI_SCALE units), colour, the
 * boundary face it lies on or -1, and the two cover words of the eighths it covers there.
 */
export const TRI_STRIDE = 13;

/** A shaped state's geometry in its cell. */
export interface PartGeometry {
  /**
   * Axis-aligned faces, RECT_STRIDE numbers each. `plane` is the face's position along its
   * axis and u0..v1 its extent along the face's U and V axes (see FACES), all in eighths of
   * a cell. A face on the cell's boundary (plane 0 or 8 on its outward side) can be hidden
   * by the neighbour.
   */
  readonly rects: readonly number[];
  readonly tris: readonly number[];
  /**
   * What the state covers of each side of its cell, as an 8 x 8 bitmask in two words per
   * face (FACES order). Bit a * 8 + b covers eighth a of the side's lower-numbered in-plane
   * axis and eighth b of the other, so a side and the facing side of the neighbour use the
   * same bits.
   */
  readonly cover: Uint32Array;
  /** Bit f set if side f (FACES order) is covered completely. */
  readonly full: number;
}

const MAX_IDS = 1 << 16;

/** Per cell-state id: is it a whole cube, what it covers, and its part geometry. */
export class ShapeTable {
  /** 1 for a whole cube. */
  readonly cube = new Uint8Array(MAX_IDS);
  /** Sides covered completely: 0x3f for a cube, 0 for empty. */
  readonly full = new Uint8Array(MAX_IDS);
  /** 1 for a state with part geometry (see geometry). */
  readonly shaped = new Uint8Array(MAX_IDS);
  /** How many ids are shaped: the mesher skips looking for parts when there are none. */
  shapedCount = 0;
  readonly geometry: (PartGeometry | undefined)[] = [];
  #size = 1;

  /** Ids described so far, counting empty. */
  get size(): number {
    return this.#size;
  }

  /** Builds a table straight from a state table (see describeStates). */
  static of(states: CellStateTable): ShapeTable {
    const table = new ShapeTable();
    table.update(1, describeStates(states));
    return table;
  }

  /** Sets the shapes of ids `from`, `from + 1`, ... */
  update(from: number, shapes: readonly StateShape[]): void {
    shapes.forEach((shape, i) => {
      const id = from + i;
      if (this.shaped[id]) this.shapedCount--;
      this.cube[id] = 0;
      this.full[id] = 0;
      this.shaped[id] = 0;
      this.geometry[id] = undefined;
      if (shape.kind === "cube") {
        this.cube[id] = 1;
        this.full[id] = 0x3f;
      } else if (shape.kind === "parts") {
        const geometry = buildGeometry(shape.parts);
        this.geometry[id] = geometry;
        this.full[id] = geometry.full;
        this.shaped[id] = 1;
        this.shapedCount++;
      }
    });
    this.#size = Math.max(this.#size, from + shapes.length);
  }
}

/** The lower and higher in-plane axes of a face, and whether its U axis is the lower one. */
export function canonicalAxes(face: number): { readonly uLow: boolean } {
  const f = FACES[face];
  if (!f) throw new RangeError(`No face ${face}`);
  return { uLow: f.u < f.v };
}

/** True if `cover` (two words) has every bit of the rectangle a0..a1 x b0..b1 (eighths). */
export function covers(
  cover: Uint32Array,
  face: number,
  a0: number,
  b0: number,
  a1: number,
  b1: number,
): boolean {
  const lo = cover[face * 2] ?? 0;
  const hi = cover[face * 2 + 1] ?? 0;
  for (let a = a0; a < a1; a++) {
    const word = a < 4 ? lo : hi;
    const shift = (a & 3) * 8;
    const want = (((1 << (b1 - b0)) - 1) << b0) << shift;
    if ((word & want) >>> 0 !== want >>> 0) return false;
  }
  return true;
}

function setCover(cover: Uint32Array, face: number, a: number, b: number): void {
  const i = face * 2 + (a < 4 ? 0 : 1);
  cover[i] = ((cover[i] ?? 0) | (1 << ((a & 3) * 8 + b))) >>> 0;
}

function buildGeometry(parts: readonly PartShape[]): PartGeometry {
  const cover = new Uint32Array(12);
  const rects: number[] = [];
  const tris: number[] = [];

  // Microblocks: fill an 8 x 8 x 8 grid of colours, then mesh its faces.
  const grid = new Uint16Array(512);
  let anyMicro = false;
  for (const part of parts) {
    for (const [x0, y0, z0, x1, y1, z1] of microBoxes(part.shape, part.slot)) {
      anyMicro = true;
      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) grid[x + z * 8 + y * 64] = part.color;
        }
      }
    }
  }
  if (anyMicro) meshGrid(grid, rects, cover);

  for (const part of parts) {
    const t = archTriangles(part.shape, part.slot);
    for (let i = 0; i + 8 < t.length; i += 9) {
      const corners = t.slice(i, i + 9);
      const face = boundaryFace(corners);
      for (const c of corners) tris.push(Math.round(c * TRI_SCALE));
      const own = new Uint32Array(12);
      if (face >= 0) coverTriangle(own, face, corners);
      tris.push(part.color, face, own[face * 2] ?? 0, own[face * 2 + 1] ?? 0);
      for (let k = 0; k < 12; k++) cover[k] = ((cover[k] ?? 0) | (own[k] ?? 0)) >>> 0;
    }
  }

  let full = 0;
  for (let f = 0; f < 6; f++) {
    if (cover[f * 2] === 0xffffffff && cover[f * 2 + 1] === 0xffffffff) full |= 1 << f;
  }
  return { rects, tris, cover, full };
}

const gridStrides = [1, 64, 8] as const; // x, y, z

/** Greedy-meshes the faces of an 8³ grid of colours into rects, and records side cover. */
function meshGrid(grid: Uint16Array, rects: number[], cover: Uint32Array): void {
  const mask = new Uint16Array(64);
  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f];
    if (!face) continue;
    const sA = gridStrides[face.axis];
    const sU = gridStrides[face.u];
    const sV = gridStrides[face.v];
    const { uLow } = canonicalAxes(f);
    for (let d = 0; d < 8; d++) {
      const next = d + face.sign;
      const boundary = next < 0 || next > 7;
      let any = false;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          const at = d * sA + u * sU + v * sV;
          const color = grid[at] ?? 0;
          const open = boundary || (grid[at + face.sign * sA] ?? 0) === 0;
          mask[u + v * 8] = color !== 0 && open ? color : 0;
          if (color !== 0 && open) any = true;
          if (color !== 0 && boundary) setCover(cover, f, uLow ? u : v, uLow ? v : u);
        }
      }
      if (!any) continue;
      const plane = face.sign > 0 ? d + 1 : d;
      greedy8(mask, (u0, v0, u1, v1, color) => rects.push(f, plane, u0, v0, u1, v1, color));
    }
  }
}

/** Merges an 8 x 8 mask of colours into rectangles. Clears the mask. */
function greedy8(
  mask: Uint16Array,
  emit: (u0: number, v0: number, u1: number, v1: number, color: number) => void,
): void {
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; ) {
      const color = mask[u + v * 8] ?? 0;
      if (color === 0) {
        u++;
        continue;
      }
      let w = 1;
      while (u + w < 8 && mask[u + w + v * 8] === color) w++;
      let h = 1;
      grow: while (v + h < 8) {
        for (let k = 0; k < w; k++) if (mask[u + k + (v + h) * 8] !== color) break grow;
        h++;
      }
      for (let dv = 0; dv < h; dv++) mask.fill(0, u + (v + dv) * 8, u + w + (v + dv) * 8);
      emit(u, v, u + w, v + h, color);
      u += w;
    }
  }
}

/** The face (FACES order) a triangle lies flat on the outside of, or -1. */
function boundaryFace(c: readonly number[]): number {
  const eps = 1e-6;
  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f];
    if (!face) continue;
    const plane = face.sign > 0 ? 1 : 0;
    let on = true;
    for (let k = 0; k < 3; k++) {
      if (Math.abs((c[k * 3 + face.axis] ?? 0) - plane) > eps) on = false;
    }
    if (!on) continue;
    // Counter-clockwise around the outward normal means the face looks out of the cell.
    const n = cross(c);
    if ((n[face.axis] ?? 0) * face.sign > 0) return f;
  }
  return -1;
}

function cross(c: readonly number[]): [number, number, number] {
  const at = (i: number) => c[i] ?? 0;
  const ax = at(3) - at(0);
  const ay = at(4) - at(1);
  const az = at(5) - at(2);
  const bx = at(6) - at(0);
  const by = at(7) - at(1);
  const bz = at(8) - at(2);
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/** Marks the eighths of side `face` a boundary triangle covers (by their centres). */
function coverTriangle(cover: Uint32Array, face: number, c: readonly number[]): void {
  const f = FACES[face];
  if (!f) return;
  const lowAxis = Math.min(f.u, f.v);
  const highAxis = Math.max(f.u, f.v);
  const p = [0, 1, 2].map((k) => [c[k * 3 + lowAxis] ?? 0, c[k * 3 + highAxis] ?? 0] as const);
  const [p0, p1, p2] = p as [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  const edge = (a: readonly [number, number], b: readonly [number, number], x: number, y: number) =>
    (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  for (let a = 0; a < 8; a++) {
    for (let b = 0; b < 8; b++) {
      const x = (a + 0.5) / 8;
      const y = (b + 0.5) / 8;
      const e0 = edge(p0, p1, x, y);
      const e1 = edge(p1, p2, x, y);
      const e2 = edge(p2, p0, x, y);
      if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) {
        setCover(cover, face, a, b);
      }
    }
  }
}
