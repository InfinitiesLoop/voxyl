import { EMPTY_ID } from "./cell-state.ts";
import type { World } from "./world.ts";

export interface RayHit {
  /** The occupied cell the ray hit. */
  readonly cell: readonly [number, number, number];
  /** Outward normal of the face it entered through; [0, 0, 0] if the ray started inside. */
  readonly normal: readonly [number, number, number];
  readonly id: number;
  readonly distance: number;
}

/**
 * Walks a ray through the grid one cell at a time (Amanatides and Woo) and returns the first
 * occupied cell within `maxDistance`. Cell [x, y, z] spans x..x+1 on each axis. `dir` need not
 * be normalised; distance is measured in units of its length.
 */
export function raycast(
  world: World,
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  maxDistance: number,
): RayHit | null {
  const L = world.layout;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const stepZ = Math.sign(dz);
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = stepX === 0 ? Infinity : (x + (stepX > 0 ? 1 : 0) - ox) / dx;
  let tMaxY = stepY === 0 ? Infinity : (y + (stepY > 0 ? 1 : 0) - oy) / dy;
  let tMaxZ = stepZ === 0 ? Infinity : (z + (stepZ > 0 ? 1 : 0) - oz) / dz;
  let normal: [number, number, number] = [0, 0, 0];
  let t = 0;

  while (t <= maxDistance) {
    if (!L.isWorldCoord(x) || !L.isWorldCoord(y) || !L.isWorldCoord(z)) {
      return null;
    }
    const id = world.getId(x, y, z);
    if (id !== EMPTY_ID) {
      return { cell: [x, y, z], normal, id, distance: t };
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      t = tMaxX;
      tMaxX += tDeltaX;
      x += stepX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY <= tMaxZ) {
      t = tMaxY;
      tMaxY += tDeltaY;
      y += stepY;
      normal = [0, -stepY, 0];
    } else {
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      z += stepZ;
      normal = [0, 0, -stepZ];
    }
  }
  return null;
}
