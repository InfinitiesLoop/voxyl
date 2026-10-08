import { archTriangles, isExclusive, microBoxes } from "@voxyl/shapes";
import type { SurfaceParts } from "../world/clipboard.ts";

/** Triangles for a preview, flat shaded: three corners per triangle, three numbers per corner. */
export interface PartMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Linear r, g, b per corner. */
  readonly colors: Float32Array;
}

const linear = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * The geometry of a surface's shaped parts, in the same cell space as the cubes: a part in
 * cell (x, y, z) fills the unit cell there, less `origin` (the box's centre, to turn about).
 * Microblocks are their boxes, architecture shapes their triangles; the same two sources the
 * editor draws from, so a preview shows what the build does.
 */
export function partMesh(parts: SurfaceParts, origin: readonly [number, number, number]): PartMesh {
  const out: number[] = [];
  const norm: number[] = [];
  const col: number[] = [];
  const count = parts.slots.length;
  for (let i = 0; i < count; i++) {
    const shape = parts.shapes[i] ?? "";
    const slot = parts.slots[i] ?? 0;
    const cx = (parts.positions[i * 3] ?? 0) - origin[0];
    const cy = (parts.positions[i * 3 + 1] ?? 0) - origin[1];
    const cz = (parts.positions[i * 3 + 2] ?? 0) - origin[2];
    const r = linear(parts.colors[i * 3] ?? 128);
    const g = linear(parts.colors[i * 3 + 1] ?? 128);
    const b = linear(parts.colors[i * 3 + 2] ?? 128);
    const push = (
      a: readonly number[],
      bb: readonly number[],
      c: readonly number[],
      n: readonly number[],
    ) => {
      for (const p of [a, bb, c]) {
        out.push(cx + (p[0] ?? 0), cy + (p[1] ?? 0), cz + (p[2] ?? 0));
        norm.push(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
        col.push(r, g, b);
      }
    };
    if (isExclusive(shape)) {
      const tris = archTriangles(shape, slot);
      for (let t = 0; t + 8 < tris.length; t += 9) {
        const a = [tris[t] ?? 0, tris[t + 1] ?? 0, tris[t + 2] ?? 0];
        const bb = [tris[t + 3] ?? 0, tris[t + 4] ?? 0, tris[t + 5] ?? 0];
        const c = [tris[t + 6] ?? 0, tris[t + 7] ?? 0, tris[t + 8] ?? 0];
        push(a, bb, c, normalOf(a, bb, c));
      }
      continue;
    }
    for (const box of microBoxes(shape, slot)) {
      const lo = [box[0] / 8, box[1] / 8, box[2] / 8];
      const hi = [box[3] / 8, box[4] / 8, box[5] / 8];
      for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        for (const sign of [1, -1]) {
          const at = (sign > 0 ? hi : lo)[axis] ?? 0;
          const corner = (cu: number, cv: number): number[] => {
            const p = [0, 0, 0];
            p[axis] = at;
            p[u] = cu;
            p[v] = cv;
            return p;
          };
          const c00 = corner(lo[u] ?? 0, lo[v] ?? 0);
          const c10 = corner(hi[u] ?? 0, lo[v] ?? 0);
          const c11 = corner(hi[u] ?? 0, hi[v] ?? 0);
          const c01 = corner(lo[u] ?? 0, hi[v] ?? 0);
          const n = [0, 0, 0];
          n[axis] = sign;
          // (u, v, axis) is right-handed, so u x v points along +axis.
          if (sign > 0) {
            push(c00, c10, c11, n);
            push(c00, c11, c01, n);
          } else {
            push(c00, c11, c10, n);
            push(c00, c01, c11, n);
          }
        }
      }
    }
  }
  return {
    positions: Float32Array.from(out),
    normals: Float32Array.from(norm),
    colors: Float32Array.from(col),
  };
}

function normalOf(a: readonly number[], b: readonly number[], c: readonly number[]): number[] {
  const ux = (b[0] ?? 0) - (a[0] ?? 0);
  const uy = (b[1] ?? 0) - (a[1] ?? 0);
  const uz = (b[2] ?? 0) - (a[2] ?? 0);
  const vx = (c[0] ?? 0) - (a[0] ?? 0);
  const vy = (c[1] ?? 0) - (a[1] ?? 0);
  const vz = (c[2] ?? 0) - (a[2] ?? 0);
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}
