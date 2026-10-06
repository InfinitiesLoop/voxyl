import type { ChangedBox } from "./world.ts";

/** A box with sorted corners (x0 <= x1 and so on), inclusive. */
export type Box = ChangedBox;

/** The box between two opposite corners given in any order: [x0, y0, z0, x1, y1, z1]. */
export function boxOf(box: readonly [number, number, number, number, number, number]): Box {
  const [ax, ay, az, bx, by, bz] = box;
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    z0: Math.min(az, bz),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
    z1: Math.max(az, bz),
  };
}

/** The smallest box holding both (either may be null). */
export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    z0: Math.min(a.z0, b.z0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    z1: Math.max(a.z1, b.z1),
  };
}

export function boxVolume(box: Box): number {
  return (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) * (box.z1 - box.z0 + 1);
}
