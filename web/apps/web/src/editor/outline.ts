// The selection's outline, as line segments any view can draw. Ported from the Godot app's
// SelectionOutline: only the silhouette, so a flat wall is one loop rather than a grid, and
// collinear unit edges merge into one segment. A plain box is twelve edges. Past OUTLINE_MAX
// cells the outline is just the bounding box.

import { type Box, boxVolume, type CellSet } from "@voxyl/core";

/** Past this many cells a selection that isn't a plain box outlines its bounding box only. */
export const OUTLINE_MAX = 60_000;

export interface Outline {
  /** Segment endpoints, xyz xyz, in cell-corner coordinates (the cell at p spans p to p + 1). */
  readonly lines: Float32Array;
  /** False when `lines` is only the bounding box of a selection too big to trace. */
  readonly exact: boolean;
  /** Every cell of the bounds is selected: the selection is that box. */
  readonly box: boolean;
  readonly bounds: Box | null;
}

const EMPTY: Outline = {
  lines: new Float32Array(0),
  exact: true,
  box: false,
  bounds: null,
};

/** The outline of a selection. */
export function outlineOf(cells: CellSet): Outline {
  const bounds = cells.bounds();
  if (!bounds || cells.size === 0) return EMPTY;
  const box = boxVolume(bounds) === cells.size;
  if (box || cells.size > OUTLINE_MAX) {
    return { lines: boxLines(bounds), exact: box, box, bounds };
  }
  return { lines: silhouette(cells), exact: true, box: false, bounds };
}

/** The twelve edges of a box, in cell-corner coordinates. */
export function boxLines(box: Box): Float32Array {
  const x0 = box.x0;
  const y0 = box.y0;
  const z0 = box.z0;
  const x1 = box.x1 + 1;
  const y1 = box.y1 + 1;
  const z1 = box.z1 + 1;
  const c = [
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y0,
    z1,
    x0,
    y0,
    z1,
    x0,
    y1,
    z0,
    x1,
    y1,
    z0,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  ];
  const edges: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const out = new Float32Array(edges.length * 6);
  let w = 0;
  for (const [a, b] of edges) {
    out[w++] = c[a * 3] ?? 0;
    out[w++] = c[a * 3 + 1] ?? 0;
    out[w++] = c[a * 3 + 2] ?? 0;
    out[w++] = c[b * 3] ?? 0;
    out[w++] = c[b * 3 + 1] ?? 0;
    out[w++] = c[b * 3 + 2] ?? 0;
  }
  return out;
}

type XYZ = [number, number, number];

function at(p: XYZ, axis: number): number {
  if (axis === 0) return p[0];
  if (axis === 1) return p[1];
  return p[2];
}

function put(p: XYZ, axis: number, value: number): void {
  if (axis === 0) p[0] = value;
  else if (axis === 1) p[1] = value;
  else p[2] = value;
}

function add(p: XYZ, q: XYZ): XYZ {
  return [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
}

/** Silhouette edges of an exact set of cells. `cells` is read, never written. */
function silhouette(cells: CellSet): Float32Array {
  const units = new Set<string>();
  const key = (p: XYZ, axis: number) => `${p[0]},${p[1]},${p[2]},${axis}`;
  cells.forEach((x, y, z) => {
    const p: XYZ = [x, y, z];
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      for (const sign of [-1, 1]) {
        const normal: XYZ = [0, 0, 0];
        put(normal, axis, sign);
        if (cells.has(x + normal[0], y + normal[1], z + normal[2])) continue;
        const plane = at(p, axis) + (sign > 0 ? 1 : 0);
        for (const [side, run] of [
          [u, v],
          [v, u],
        ] as const) {
          for (const edge of [-1, 1]) {
            const beside: XYZ = [0, 0, 0];
            put(beside, side, edge);
            const neighbor = add(p, beside);
            // The surface carries on flat into the neighbour: this edge isn't a corner.
            if (cells.has(...neighbor) && !cells.has(...add(neighbor, normal))) continue;
            const start: XYZ = [0, 0, 0];
            put(start, axis, plane);
            put(start, side, at(p, side) + (edge > 0 ? 1 : 0));
            put(start, run, at(p, run));
            units.add(key(start, run));
          }
        }
      }
    }
  });

  const has = (p: XYZ, axis: number) => units.has(key(p, axis));
  const segments: number[] = [];
  for (const unit of units) {
    const [xs, ys, zs, runText] = unit.split(",");
    const start: XYZ = [Number(xs), Number(ys), Number(zs)];
    const run = Number(runText);
    const back: XYZ = [start[0], start[1], start[2]];
    put(back, run, at(back, run) - 1);
    if (has(back, run)) continue;
    const end: XYZ = [start[0], start[1], start[2]];
    while (has(end, run)) put(end, run, at(end, run) + 1);
    segments.push(start[0], start[1], start[2], end[0], end[1], end[2]);
  }
  return Float32Array.from(segments);
}
