// Where a command acts (web-core.md, section 5). For now a region is a box. Step 3 widens this
// schema into the full expression language (selection, palette, semantic, structure, set
// algebra); commands that take a `Region` pick that up without changing.

import { z } from "zod";
import type { ChangedBox } from "./world.ts";

const Coord = z.number().int();

/** Two opposite corners, inclusive, in any order: [x0, y0, z0, x1, y1, z1]. */
export const BoxArg = z.tuple([Coord, Coord, Coord, Coord, Coord, Coord]);

export const Region = z.strictObject({ box: BoxArg });
export type Region = z.output<typeof Region>;

/** A box with sorted corners (x0 <= x1 and so on), inclusive. */
export type Box = ChangedBox;

export function boxOf(region: Region): Box {
  const [ax, ay, az, bx, by, bz] = region.box;
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
