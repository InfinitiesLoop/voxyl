// The six faces of a cell, in the order quads encode them: +X, -X, +Y, -Y, +Z, -Z.
// Axis numbers: 0 = x, 1 = y, 2 = z.
//
// Each face spans two in-plane axes, U and V, chosen so that U x V points out of the face.
// A quad drawn (0,0) -> (1,0) -> (1,1) -> (0,1) in (U, V) then winds counter-clockwise seen
// from outside, so every face survives back-face culling without per-face winding logic.

export type Axis = 0 | 1 | 2;

export interface FaceAxes {
  readonly axis: Axis;
  readonly sign: 1 | -1;
  readonly u: Axis;
  readonly v: Axis;
}

export const FACES: readonly FaceAxes[] = [
  { axis: 0, sign: 1, u: 1, v: 2 }, // +X: Y x Z = +X
  { axis: 0, sign: -1, u: 2, v: 1 }, // -X: Z x Y = -X
  { axis: 1, sign: 1, u: 2, v: 0 }, // +Y: Z x X = +Y
  { axis: 1, sign: -1, u: 0, v: 2 }, // -Y: X x Z = -Y
  { axis: 2, sign: 1, u: 0, v: 1 }, // +Z: X x Y = +Z
  { axis: 2, sign: -1, u: 1, v: 0 }, // -Z: Y x X = -Z
];

/** Steps in a chunk's cell array per axis (x, y, z), matching ChunkLayout's index order. */
export function axisStrides(size: number): readonly [number, number, number] {
  return [1, size * size, size];
}
