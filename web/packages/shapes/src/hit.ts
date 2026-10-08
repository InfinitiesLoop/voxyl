// Aiming at a placed part: where a ray meets a part's geometry inside its cell. Cube cells are
// found a whole cell at a time by the grid walk; a cell of parts has gaps (a slab leaves the
// rest of the cell open), so the walk asks here whether the ray really touches a part, which
// part, and which of its faces it meets.

import { archTriangles } from "./arch.ts";
import { microBoxes } from "./micro.ts";
import { sideFromNormal, type Vec3 } from "./placement.ts";
import { isExclusive } from "./rules.ts";

/** Where a ray meets a part. `side` is the outward side of the face it hit. */
export interface PartHit {
  /** Distance along the ray (in units of its direction's length). */
  readonly t: number;
  readonly side: number;
}

/**
 * The nearest point where a ray meets the part, in cell-local space (0..1 on each axis), or
 * null if it misses. Microblocks are boxes on the 1/8 grid. Architecture shapes are their
 * triangles, so a ray passes over the low side of a roof tile and stops on its slope.
 */
export function hitPart(
  shape: string,
  slot: number,
  origin: Vec3,
  dir: Vec3,
  maxT = Number.POSITIVE_INFINITY,
): PartHit | null {
  if (isExclusive(shape)) return hitTriangles(archTriangles(shape, slot), origin, dir, maxT);
  let best: PartHit | null = null;
  for (const box of microBoxes(shape, slot)) {
    const hit = hitBox(
      [box[0] / 8, box[1] / 8, box[2] / 8],
      [box[3] / 8, box[4] / 8, box[5] / 8],
      origin,
      dir,
      maxT,
    );
    if (hit && (best === null || hit.t < best.t)) best = hit;
  }
  return best;
}

/** Slab test against a box. A ray that starts inside meets the face it leaves by, ignored here. */
function hitBox(lo: Vec3, hi: Vec3, o: Vec3, d: Vec3, maxT: number): PartHit | null {
  let tNear = Number.NEGATIVE_INFINITY;
  let tFar = Number.POSITIVE_INFINITY;
  let side = -1;
  for (let axis = 0; axis < 3; axis++) {
    const origin = o[axis] as number;
    const dir = d[axis] as number;
    const min = lo[axis] as number;
    const max = hi[axis] as number;
    if (dir === 0) {
      if (origin < min || origin > max) return null;
      continue;
    }
    // Entering through the min face means the face looks toward -axis.
    const t1 = (min - origin) / dir;
    const t2 = (max - origin) / dir;
    const enter = Math.min(t1, t2);
    const exit = Math.max(t1, t2);
    if (enter > tNear) {
      tNear = enter;
      // axis 0 is x: sides 4 (-X) and 5 (+X); 1 is y: 0 and 1; 2 is z: 2 and 3.
      const base = axis === 0 ? 4 : axis === 1 ? 0 : 2;
      side = base + (dir < 0 ? 1 : 0);
    }
    tFar = Math.min(tFar, exit);
    if (tNear > tFar) return null;
  }
  if (side < 0 || tNear < 0 || tNear > maxT) return null;
  return { t: tNear, side };
}

/** Möller–Trumbore against triangles (9 numbers each); the nearest front-facing hit. */
function hitTriangles(tris: readonly number[], o: Vec3, d: Vec3, maxT: number): PartHit | null {
  let best: PartHit | null = null;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ax = tris[i] as number;
    const ay = tris[i + 1] as number;
    const az = tris[i + 2] as number;
    const e1: Vec3 = [
      (tris[i + 3] as number) - ax,
      (tris[i + 4] as number) - ay,
      (tris[i + 5] as number) - az,
    ];
    const e2: Vec3 = [
      (tris[i + 6] as number) - ax,
      (tris[i + 7] as number) - ay,
      (tris[i + 8] as number) - az,
    ];
    const p: Vec3 = [
      d[1] * e2[2] - d[2] * e2[1],
      d[2] * e2[0] - d[0] * e2[2],
      d[0] * e2[1] - d[1] * e2[0],
    ];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-9) continue;
    const inv = 1 / det;
    const s: Vec3 = [o[0] - ax, o[1] - ay, o[2] - az];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q: Vec3 = [
      s[1] * e1[2] - s[2] * e1[1],
      s[2] * e1[0] - s[0] * e1[2],
      s[0] * e1[1] - s[1] * e1[0],
    ];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (t < 0 || t > maxT || (best !== null && t >= best.t)) continue;
    // The triangle's normal (wound counter-clockwise from outside); a back face isn't hit.
    const n: Vec3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0) continue;
    best = { t, side: sideFromNormal(n) };
  }
  return best;
}
