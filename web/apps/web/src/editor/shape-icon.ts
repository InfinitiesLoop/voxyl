// A small picture of a shape for the shape picker and the inventory: the shape drawn in
// isometric from above and to one side, as flat polygons in three shades (top, right, left).
// Pure geometry, so it tests in Node; ShapeIcon.tsx draws the result as SVG.

import { archSlot, archTriangles, isExclusive, microBoxes } from "@voxyl/shapes";

/** One face of the picture: points as "x,y" pairs in a 0..100 box, and which shade to use. */
export interface IconPolygon {
  readonly points: string;
  /** 0 the top face, 1 the right-hand face, 2 the left-hand face (lighter to darker). */
  readonly shade: 0 | 1 | 2;
}

type V3 = readonly [number, number, number];

/** The slot a shape is drawn in: the one that shows it best from this angle. */
export function iconSlot(shape: string): number {
  return isExclusive(shape) ? archSlot(0, 2) : 0;
}

/** Triangles (a, b, c) wound counter-clockwise from outside, for a shape's icon slot. */
function trianglesOf(shape: string, slot: number): V3[][] {
  const out: V3[][] = [];
  if (isExclusive(shape)) {
    const t = archTriangles(shape, slot);
    for (let i = 0; i + 8 < t.length; i += 9) {
      out.push([
        [t[i] ?? 0, t[i + 1] ?? 0, t[i + 2] ?? 0],
        [t[i + 3] ?? 0, t[i + 4] ?? 0, t[i + 5] ?? 0],
        [t[i + 6] ?? 0, t[i + 7] ?? 0, t[i + 8] ?? 0],
      ]);
    }
    return out;
  }
  for (const b of microBoxes(shape, slot)) {
    const [x0, y0, z0, x1, y1, z1] = b.map((v) => v / 8) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    // Each face as two triangles, counter-clockwise seen from outside.
    const quads: V3[][] = [
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ], // +X
      [
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
        [x0, y0, z0],
      ], // -X
      [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ], // +Y
      [
        [x0, y0, z1],
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
      ], // -Y
      [
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
        [x0, y0, z1],
      ], // +Z
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ], // -Z
    ];
    for (const q of quads) {
      out.push([q[0] as V3, q[1] as V3, q[2] as V3], [q[0] as V3, q[2] as V3, q[3] as V3]);
    }
  }
  return out;
}

/** Where a point lands in the picture, before it is fitted to the box. */
function project([x, y, z]: V3): [number, number] {
  return [(x - z) * 0.866, (x + z) * 0.5 - y];
}

/** The shape as polygons, far to near, fitted to a 100 × 100 box with a little margin. */
export function shapeIcon(shape: string, slot = iconSlot(shape)): IconPolygon[] {
  const faces: { depth: number; shade: 0 | 1 | 2; pts: [number, number][] }[] = [];
  for (const [a, b, c] of trianglesOf(shape, slot) as [V3, V3, V3][]) {
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: V3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    // The viewer is toward +x +y +z: a face is seen when its normal points that way.
    const facing = n[0] + n[1] + n[2];
    if (facing <= 1e-9) continue;
    const length = Math.hypot(...n);
    // The shade follows the dominant axis of the normal: up is lightest, then +X, then +Z.
    const [nx, ny, nz] = [n[0] / length, n[1] / length, n[2] / length];
    const shade = ny >= Math.abs(nx) && ny >= Math.abs(nz) ? 0 : nx >= nz ? 1 : 2;
    faces.push({
      depth: (a[0] + b[0] + c[0] + a[1] + b[1] + c[1] + a[2] + b[2] + c[2]) / 3,
      shade,
      pts: [project(a), project(b), project(c)],
    });
  }
  if (faces.length === 0) return [];
  faces.sort((p, q) => p.depth - q.depth);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  // Fit to a whole cell's outline, so a thin shape reads thin beside a full block.
  for (const p of [
    [0, 0, 0],
    [1, 0, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 0],
    [1, 1, 0],
    [0, 1, 1],
    [1, 1, 1],
  ] as V3[]) {
    const [px, py] = project(p);
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  const scale = 90 / Math.max(maxX - minX, maxY - minY);
  const offsetX = 50 - ((minX + maxX) / 2) * scale;
  const offsetY = 50 - ((minY + maxY) / 2) * scale;
  return faces.map(({ shade, pts }) => ({
    shade,
    points: pts
      .map(
        ([px, py]) => `${(px * scale + offsetX).toFixed(1)},${(py * scale + offsetY).toFixed(1)}`,
      )
      .join(" "),
  }));
}
