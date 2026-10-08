// The clipboard and prefabs as the editor uses them: a piece (cells lifted out of a project,
// see core's piece.ts) seen as a list of cells for the paste ghost, where its cells land when
// pasted, and a small picture of it. Pure functions over a Piece, so they test in Node.
// Runs in the world worker.

import {
  applyMatrix,
  type Direction,
  forEachPieceCell,
  type MirrorAxis,
  type Piece,
  placementMatrix,
  turnsBetween,
} from "@voxyl/core";
import type { Vec3 } from "./protocol.ts";

/** Where a paste goes and how the piece sits there: what the Paste tool's options say. */
export interface PasteArgs {
  /** Quarter turns clockwise seen from above. */
  readonly turn: number;
  /** Mirror across the plane normal to x (east and west swap), after turning. */
  readonly mirror: boolean;
  /** A shift from the aimed cell, in cells. */
  readonly offset: Vec3;
  /** The piece's empty cells clear what they land on. */
  readonly air: boolean;
  /** Pins the anchor to this cell instead of the cell aimed at (a locked paste). */
  readonly at?: Vec3;
}

export const NO_PASTE_TURN: PasteArgs = { turn: 0, mirror: false, offset: [0, 0, 0], air: false };

/** The mirror a paste asks of the core. */
export function mirrorOf(args: Pick<PasteArgs, "mirror">): MirrorAxis | undefined {
  return args.mirror ? "x" : undefined;
}

/** A piece's occupied cells, by position in the piece, and the piece semantic each shows. */
export interface PieceCells {
  /** x, y, z per cell, from the piece's corner. */
  readonly positions: Int32Array;
  /** The 1-based piece semantic number each cell shows (its first part's, for a cell of parts). */
  readonly semantics: Uint16Array;
}

/** The cells of a piece that hold something (air is left out). */
export function pieceCells(piece: Piece): PieceCells {
  const positions: number[] = [];
  const semantics: number[] = [];
  const semanticOfState = new Map<number, number>();
  forEachPieceCell(piece, (x, y, z, n) => {
    let semantic = semanticOfState.get(n);
    if (semantic === undefined) {
      const state = piece.states[n - 1];
      semantic = state === null || state === undefined ? 0 : (state[3]?.[0]?.[0] ?? state[0]);
      semanticOfState.set(n, semantic);
    }
    if (semantic === 0) return; // air
    positions.push(x, y, z);
    semantics.push(semantic);
  });
  return { positions: Int32Array.from(positions), semantics: Uint16Array.from(semantics) };
}

/** The cell a paste puts at its target: the middle of the piece's footprint, on its floor. */
export function defaultAnchor(size: readonly [number, number, number]): [number, number, number] {
  return [Math.floor(size[0] / 2), 0, Math.floor(size[2] / 2)];
}

/** The matrix a paste turns the piece by: toward the project's north, then the user's turn. */
export function pasteMatrix(piece: Piece, north: Direction, args: PasteArgs): number[] {
  return placementMatrix(args.turn + turnsBetween(piece.north, north), mirrorOf(args));
}

/**
 * Where each cell of the piece lands when its anchor is put at `at` (plus the offset),
 * x, y, z per cell, in the same order as `cells.positions`.
 */
export function placedPositions(
  piece: Piece,
  cells: PieceCells,
  north: Direction,
  at: Vec3,
  args: PasteArgs,
): Int32Array {
  const m = pasteMatrix(piece, north, args);
  const [ax, ay, az] = piece.anchor ?? defaultAnchor(piece.size);
  const out = new Int32Array(cells.positions.length);
  const target: Vec3 = [at[0] + args.offset[0], at[1] + args.offset[1], at[2] + args.offset[2]];
  for (let i = 0; i < cells.positions.length; i += 3) {
    const [x, y, z] = applyMatrix(m, [
      (cells.positions[i] ?? 0) - ax,
      (cells.positions[i + 1] ?? 0) - ay,
      (cells.positions[i + 2] ?? 0) - az,
    ]);
    out[i] = target[0] + x;
    out[i + 1] = target[1] + y;
    out[i + 2] = target[2] + z;
  }
  return out;
}

/** The box a pasted piece fills, as min and max cell corners (max exclusive). */
export function placedBox(
  piece: Piece,
  north: Direction,
  at: Vec3,
  args: PasteArgs,
): { min: Vec3; max: Vec3 } {
  const m = pasteMatrix(piece, north, args);
  const [ax, ay, az] = piece.anchor ?? defaultAnchor(piece.size);
  const [w, h, d] = piece.size;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const target: Vec3 = [at[0] + args.offset[0], at[1] + args.offset[1], at[2] + args.offset[2]];
  // The box's corners, in cell terms: its cells run from 0 to size - 1.
  for (const x of [0, w - 1]) {
    for (const y of [0, h - 1]) {
      for (const z of [0, d - 1]) {
        const p = applyMatrix(m, [x - ax, y - ay, z - az]);
        for (let axis = 0; axis < 3; axis++) {
          const v = (target[axis] ?? 0) + (p[axis] ?? 0);
          min[axis] = Math.min(min[axis] ?? v, v);
          max[axis] = Math.max(max[axis] ?? v + 1, v + 1);
        }
      }
    }
  }
  return {
    min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
  };
}

// --- Pictures ---

/** The size of a prefab's stored picture, in pixels each way. */
export const THUMB_SIZE = 64;

/**
 * A small picture of a piece, as RGBA: its cells seen from above and to one side, each cell's
 * visible faces in three shades of its semantic's colour. Transparent where nothing is.
 * `colorOf` gives a piece semantic's colour as 0xrrggbb.
 */
export function pieceThumbnail(
  piece: Piece,
  colorOf: (semantic: number) => number,
  size = THUMB_SIZE,
): Uint8Array {
  const [w, h, d] = piece.size;
  const cells = pieceCells(piece);
  const out = new Uint8Array(size * size * 4);
  const count = cells.semantics.length;
  if (count === 0) return out;
  // Occupancy by cell, and each cell's colour, so a face can tell whether it is hidden.
  const grid = new Uint16Array(w * h * d);
  for (let i = 0; i < count; i++) {
    const x = cells.positions[i * 3] ?? 0;
    const y = cells.positions[i * 3 + 1] ?? 0;
    const z = cells.positions[i * 3 + 2] ?? 0;
    grid[x + w * (z + d * y)] = cells.semantics[i] ?? 0;
  }
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d ? 0 : (grid[x + w * (z + d * y)] ?? 0);
  // Fit the whole box's outline in the picture, with a margin.
  const project = (x: number, y: number, z: number): [number, number] => [
    (x - z) * 0.866,
    (x + z) * 0.5 - y,
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of [0, w]) {
    for (const y of [0, h]) {
      for (const z of [0, d]) {
        const [px, py] = project(x, y, z);
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
    }
  }
  const scale = (size - 4) / Math.max(maxX - minX, maxY - minY);
  const ox = size / 2 - ((minX + maxX) / 2) * scale;
  const oy = size / 2 - ((minY + maxY) / 2) * scale;
  const screen = (x: number, y: number, z: number): [number, number] => {
    const [px, py] = project(x, y, z);
    return [px * scale + ox, py * scale + oy];
  };
  const shade = (rgb: number, k: number): [number, number, number] => [
    Math.round(((rgb >> 16) & 0xff) * k),
    Math.round(((rgb >> 8) & 0xff) * k),
    Math.round((rgb & 0xff) * k),
  ];
  // Far to near: a cell is drawn after every cell at or below it in all three directions.
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const s = at(x, y, z);
        if (s === 0) continue;
        const rgb = colorOf(s);
        if (at(x, y + 1, z) === 0) {
          fillQuad(
            out,
            size,
            [
              screen(x, y + 1, z),
              screen(x + 1, y + 1, z),
              screen(x + 1, y + 1, z + 1),
              screen(x, y + 1, z + 1),
            ],
            shade(rgb, 1),
          );
        }
        if (at(x + 1, y, z) === 0) {
          fillQuad(
            out,
            size,
            [
              screen(x + 1, y, z),
              screen(x + 1, y + 1, z),
              screen(x + 1, y + 1, z + 1),
              screen(x + 1, y, z + 1),
            ],
            shade(rgb, 0.78),
          );
        }
        if (at(x, y, z + 1) === 0) {
          fillQuad(
            out,
            size,
            [
              screen(x, y, z + 1),
              screen(x, y + 1, z + 1),
              screen(x + 1, y + 1, z + 1),
              screen(x + 1, y, z + 1),
            ],
            shade(rgb, 0.58),
          );
        }
      }
    }
  }
  return out;
}

/** Fills a convex quad (corners in order) with a colour, a pixel at a time. */
function fillQuad(
  rgba: Uint8Array,
  size: number,
  corners: readonly [number, number][],
  color: readonly [number, number, number],
): void {
  let top = Infinity;
  let bottom = -Infinity;
  for (const [, y] of corners) {
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(size - 1, Math.ceil(bottom));
  for (let row = y0; row <= y1; row++) {
    const y = row + 0.5;
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const [ax, ay] = corners[i] as [number, number];
      const [bx, by] = corners[(i + 1) % corners.length] as [number, number];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    if (left > right) continue;
    const x0 = Math.max(0, Math.round(left));
    const x1 = Math.min(size, Math.round(right));
    for (let col = x0; col < x1; col++) {
      const at = (row * size + col) * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      rgba[at + 3] = 255;
    }
  }
}
