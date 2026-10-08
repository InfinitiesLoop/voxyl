// How a 2D view's screen maps onto the world. A slice is the plane of cells at `depth` along
// `axis`; inside it, cells have plane coordinates (u, v): (x, z) for a plan (axis 1), (z, y)
// across x (axis 0), (x, y) across z (axis 2). The screen has its own cell coordinates
// (s right, t down), which map to (u, v) by quarter turns and flips, so a plan can put the
// project's north at the top.

import type { Direction } from "@voxyl/core";

export type SliceAxis = 0 | 1 | 2;

/** Plane (u, v) and depth to world (x, y, z). */
export function planeToWorld(
  axis: SliceAxis,
  depth: number,
  u: number,
  v: number,
): [number, number, number] {
  if (axis === 1) return [u, depth, v];
  if (axis === 0) return [depth, v, u];
  return [u, v, depth];
}

/** World (x, y, z) to plane (u, v) and depth. */
export function worldToPlane(
  axis: SliceAxis,
  [x, y, z]: readonly [number, number, number],
): [u: number, v: number, depth: number] {
  if (axis === 1) return [x, z, y];
  if (axis === 0) return [z, y, x];
  return [x, y, z];
}

/**
 * Screen axes in plane terms: screen right is +/-u or +/-v, and screen down the other.
 * `sign` is +1 or -1; `onU` says whether that screen axis runs along u.
 */
export interface ScreenAxis {
  readonly onU: boolean;
  readonly sign: 1 | -1;
}

export interface Orientation {
  readonly right: ScreenAxis;
  readonly down: ScreenAxis;
}

/**
 * How a slice is shown. A plan puts the project's real north at the top (settings.north names
 * which of its directions that is), with east to the right, as a map does. A cut across x or
 * z shows up as up, with +z or +x to the right.
 */
export function orientationFor(axis: SliceAxis, north: Direction): Orientation {
  if (axis !== 1) return { right: { onU: true, sign: 1 }, down: { onU: false, sign: -1 } };
  // u = x, v = z; the project's north is -z, east +x, south +z, west -x.
  switch (north) {
    case "north":
      return { right: { onU: true, sign: 1 }, down: { onU: false, sign: 1 } };
    case "east":
      return { right: { onU: false, sign: 1 }, down: { onU: true, sign: -1 } };
    case "south":
      return { right: { onU: true, sign: -1 }, down: { onU: false, sign: -1 } };
    case "west":
      return { right: { onU: false, sign: -1 }, down: { onU: true, sign: 1 } };
  }
}

/** The plane cell shown at screen cell (s, t). */
export function screenToPlane(o: Orientation, s: number, t: number): [u: number, v: number] {
  const along = (a: ScreenAxis, n: number) => (a.sign > 0 ? n : -n - 1);
  const fromRight = along(o.right, s);
  const fromDown = along(o.down, t);
  return o.right.onU ? [fromRight, fromDown] : [fromDown, fromRight];
}

/** The screen cell showing plane cell (u, v): the inverse of screenToPlane. */
export function planeToScreen(o: Orientation, u: number, v: number): [s: number, t: number] {
  const back = (a: ScreenAxis, n: number) => (a.sign > 0 ? n : -n - 1);
  return o.right.onU ? [back(o.right, u), back(o.down, v)] : [back(o.right, v), back(o.down, u)];
}

/**
 * A view turned and mirrored on top of its orientation: `turns` quarter turns clockwise (the
 * picture turns, as when you rotate a map), then `mirror` flips it left to right. The 2D
 * bar's View menu sets these; they change only how the slice is shown.
 */
export function turnedOrientation(o: Orientation, turns: number, mirror: boolean): Orientation {
  let right = o.right;
  let down = o.down;
  const flip = (a: ScreenAxis): ScreenAxis => ({ onU: a.onU, sign: a.sign > 0 ? -1 : 1 });
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) {
    // Clockwise: what was up is now right, and what was right is now down.
    const nextRight = flip(down);
    down = right;
    right = nextRight;
  }
  if (mirror) right = flip(right);
  return { right, down };
}
