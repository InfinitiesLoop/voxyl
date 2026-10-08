// What a part looks like from above (or across): its footprint on a 2D slice. A part is boxes
// on the 1/8 grid or the triangles of a roof, in its cell; a slice drops the axis it looks
// along and keeps the other two, so a slab shows as a rectangle and a roof tile as the polygon
// of its slope. Pure geometry: GridView fills the polygons.

import type { PartDraw } from "../world/protocol.ts";
import { type Orientation, type SliceAxis, worldToPlane } from "./plane.ts";

/** One filled shape inside a cell: corners as fractions of the cell's width and height. */
export interface FootprintPolygon {
  readonly points: readonly (readonly [number, number])[];
  /** 0xrrggbb. */
  readonly color: number;
  /** How far toward the viewer it is (0 to 1); nearer shapes are drawn later. */
  readonly depth: number;
  /** Draw an edge round it (boxes do; a roof's triangles would show their seams). */
  readonly outline: boolean;
}

/** Plane fractions (u, v) of a point in a cell, and its depth, as screen fractions. */
function toScreen(
  axis: SliceAxis,
  o: Orientation,
  x: number,
  y: number,
  z: number,
): { readonly s: number; readonly t: number; readonly depth: number } {
  const [u, v, depth] = worldToPlane(axis, [x, y, z]);
  const along = (a: Orientation["right"]) => {
    const value = a.onU ? u : v;
    return a.sign > 0 ? value : 1 - value;
  };
  return { s: along(o.right), t: along(o.down), depth };
}

/**
 * The shapes a cell of parts draws on a slice, far to near. Boxes are rectangles; triangles are
 * triangles. Empty for a part with no geometry.
 */
export function footprint(
  parts: readonly PartDraw[],
  axis: SliceAxis,
  o: Orientation,
): FootprintPolygon[] {
  const out: FootprintPolygon[] = [];
  for (const part of parts) {
    for (let i = 0; i + 5 < part.boxes.length; i += 6) {
      const [x0, y0, z0, x1, y1, z1] = part.boxes.slice(i, i + 6).map((n) => n / 8) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const a = toScreen(axis, o, x0, y0, z0);
      const b = toScreen(axis, o, x1, y1, z1);
      const s0 = Math.min(a.s, b.s);
      const s1 = Math.max(a.s, b.s);
      const t0 = Math.min(a.t, b.t);
      const t1 = Math.max(a.t, b.t);
      out.push({
        points: [
          [s0, t0],
          [s1, t0],
          [s1, t1],
          [s0, t1],
        ],
        color: part.color,
        // The nearer face of the box along the viewing axis.
        depth: Math.max(a.depth, b.depth),
        outline: true,
      });
    }
    for (let i = 0; i + 8 < part.tris.length; i += 9) {
      const corners = [0, 3, 6].map((k) =>
        toScreen(
          axis,
          o,
          part.tris[i + k] ?? 0,
          part.tris[i + k + 1] ?? 0,
          part.tris[i + k + 2] ?? 0,
        ),
      );
      out.push({
        points: corners.map((c) => [c.s, c.t] as const),
        color: part.color,
        depth: corners.reduce((sum, c) => sum + c.depth, 0) / 3,
        outline: false,
      });
    }
  }
  return out.sort((p, q) => p.depth - q.depth);
}
