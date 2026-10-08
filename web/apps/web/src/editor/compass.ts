// Compass math for the views. The project's settings.north names which of its own directions
// is the real north; the sky, the 2D plan and the compass all follow it.

import type { Direction } from "@voxyl/core";
import type { Orientation, ScreenAxis, SliceAxis } from "../views/plane.ts";

/** The real north as a vector in the project's own axes (x, z): its north is -z. */
export const REAL_NORTH: Record<Direction, readonly [number, number]> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

export const COMPASS_POINTS = ["N", "E", "S", "W"] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/**
 * The clockwise angle (radians) from screen-up to the real north, for a 3D camera turned
 * `yaw` about the vertical (FlyCamera's yaw: 0 looks toward -z). Looking north it is 0;
 * looking east, north is to the left (-π/2). It ignores pitch, so a camera looking straight
 * down reads as if level: screen-up is where it was heading.
 */
export function northHeading(yaw: number, north: Direction): number {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // Screen right, on the ground.
  const rx = -fz;
  const rz = fx;
  const [nx, nz] = REAL_NORTH[north];
  return Math.atan2(nx * rx + nz * rz, nx * fx + nz * fz);
}

/** The real compass point nearest a direction in the project's axes (x, z). */
export function compassPoint(dx: number, dz: number, north: Direction): CompassPoint {
  const [nx, nz] = REAL_NORTH[north];
  // East is north turned a quarter clockwise, seen from above.
  const ex = -nz;
  const ez = nx;
  const bearing = Math.atan2(dx * ex + dz * ez, dx * nx + dz * nz);
  const quarter = Math.round(bearing / (Math.PI / 2));
  return COMPASS_POINTS[((quarter % 4) + 4) % 4] ?? "N";
}

/**
 * The horizontal unit vector (x, z) toward a compass bearing: degrees clockwise from the real
 * north, so 90 is the real east.
 */
export function bearingVector(degrees: number, north: Direction): [number, number] {
  const [nx, nz] = REAL_NORTH[north];
  const ex = -nz;
  const ez = nx;
  const b = (degrees * Math.PI) / 180;
  return [nx * Math.cos(b) + ex * Math.sin(b), nz * Math.cos(b) + ez * Math.sin(b)];
}

/**
 * Where north sits on a 2D view: the clockwise angle from screen-up, and whether the view is
 * mirrored (east then runs counter-clockwise from north). Null when screen-up isn't horizontal,
 * which a plan never is.
 */
export function viewCompass(
  o: Orientation,
  axis: SliceAxis,
  north: Direction,
): { heading: number; mirrored: boolean } | null {
  const [fx, , fz] = screenAxis(flip(o.down), axis);
  if (fx === 0 && fz === 0) return null;
  const [rx, , rz] = screenAxis(o.right, axis);
  const [nx, nz] = REAL_NORTH[north];
  return {
    heading: Math.atan2(nx * rx + nz * rz, nx * fx + nz * fz),
    mirrored: fx * rz - fz * rx < 0,
  };
}

/**
 * The real directions at the left and right of a cut. After a quarter turn those edges are
 * up and down, and the words say so.
 */
export function cutLabels(
  o: Orientation,
  axis: SliceAxis,
  north: Direction,
): { left: string; right: string } {
  const [x, y, z] = screenAxis(o.right, axis);
  if (x === 0 && z === 0) {
    const up = y > 0;
    return { left: up ? "down" : "up", right: up ? "up" : "down" };
  }
  return {
    left: compassPoint(-x, -z, north),
    right: compassPoint(x, z, north),
  };
}

/** A screen axis as a world vector. Screen-up is the flip of screen-down. */
function screenAxis(a: ScreenAxis, axis: SliceAxis): [number, number, number] {
  const u = a.onU ? a.sign : 0;
  const v = a.onU ? 0 : a.sign;
  if (axis === 1) return [u, 0, v];
  if (axis === 0) return [0, v, u];
  return [u, v, 0];
}

function flip(a: ScreenAxis): ScreenAxis {
  return { onU: a.onU, sign: a.sign > 0 ? -1 : 1 };
}

/** The bearing (degrees clockwise from the real north) of a horizontal direction (x, z). */
export function bearingOf(dx: number, dz: number, north: Direction): number {
  const [nx, nz] = REAL_NORTH[north];
  const deg = (Math.atan2(dx * -nz + dz * nx, dx * nx + dz * nz) * 180) / Math.PI;
  return (deg + 360) % 360;
}
