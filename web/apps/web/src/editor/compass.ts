// Compass math for the views. The project's settings.north names which of its own directions
// is the real north; the sky, the 2D plan and the compass all follow it.

import type { Direction } from "@voxyl/core";

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

/** The bearing (degrees clockwise from the real north) of a horizontal direction (x, z). */
export function bearingOf(dx: number, dz: number, north: Direction): number {
  const [nx, nz] = REAL_NORTH[north];
  const deg = (Math.atan2(dx * -nz + dz * nx, dx * nx + dz * nz) * 180) / Math.PI;
  return (deg + 360) % 360;
}
