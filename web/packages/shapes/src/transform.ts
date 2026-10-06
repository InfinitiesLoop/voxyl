// How part slots move when a cell is turned or mirrored, found from each shape's own geometry
// rather than per-family tables:
//
// - A microblock slot is a set of boxes on the 8³ grid; its image is the slot of the same
//   shape filling exactly the moved cells.
// - An architecture slot is itself a rotation (side and turn), so under a rotation its image is
//   the slot whose rotation is the composition, exactly. A mirror isn't a rotation: the image
//   is the slot that is the shape mirrored across one of its own axes, when that looks like
//   the mirrored part (most roof shapes are symmetric), and otherwise any slot that does.
//
// A part with no image (a chiral shape under a mirror, or a shape without known geometry)
// gets null, and the caller reports it rather than guessing.

import { ARCH_SHAPES, ARCH_SLOTS, archRotation, archTriangles } from "./arch.ts";
import { MICRO_SHAPES, microBoxes, microSlotCount } from "./micro.ts";

/**
 * A transform of the cell about its centre: a signed permutation matrix, row-major, which may
 * be a rotation or include a mirror (determinant -1).
 */
export type CellMatrix = readonly number[];

const cache = new Map<string, number | null>();

/** The slot `slot` of `shape` lands in under `m`, or null if no slot of the shape matches. */
export function transformSlot(shape: string, slot: number, m: CellMatrix): number | null {
  const key = `${shape}|${slot}|${m.join(",")}`;
  let out = cache.get(key);
  if (out === undefined) {
    out = findSlot(shape, slot, m);
    cache.set(key, out);
  }
  return out;
}

/** Whether transformSlot knows the shape (its geometry is defined). */
export function isKnownShape(shape: string): boolean {
  return shape in MICRO_SHAPES || shape in ARCH_SHAPES;
}

/** Whether two slots of a shape fill the same space (some shapes look alike in several). */
export function slotsLookAlike(shape: string, a: number, b: number): boolean {
  if (a === b) return true;
  if (shape in MICRO_SHAPES) return microKey(shape, a, IDENTITY) === microKey(shape, b, IDENTITY);
  if (shape in ARCH_SHAPES) return archKey(shape, a, IDENTITY) === archKey(shape, b, IDENTITY);
  return false;
}

const IDENTITY: CellMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const MIRRORS: readonly CellMatrix[] = [
  [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, -1],
  [1, 0, 0, 0, -1, 0, 0, 0, 1],
];

function findSlot(shape: string, slot: number, m: CellMatrix): number | null {
  if (shape in MICRO_SHAPES) {
    const n = microSlotCount(shape);
    if (!Number.isInteger(slot) || slot < 0 || slot >= n) return null;
    const want = microKey(shape, slot, m);
    for (let s = 0; s < n; s++) if (microKey(shape, s, IDENTITY) === want) return s;
    return null;
  }
  if (shape in ARCH_SHAPES) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= ARCH_SLOTS) return null;
    const moved = mul(m, archRotation(slot >> 2, slot & 3));
    if (det(m) > 0) return archSlotOf(moved);
    const want = archKey(shape, slot, m);
    for (const mirror of MIRRORS) {
      const s = archSlotOf(mul(moved, mirror));
      if (s !== null && archKey(shape, s, IDENTITY) === want) return s;
    }
    for (let s = 0; s < ARCH_SLOTS; s++) if (archKey(shape, s, IDENTITY) === want) return s;
    return null;
  }
  return null;
}

/** The cells of the 8³ grid a microblock slot fills, moved by `m`, as a string. */
function microKey(shape: string, slot: number, m: CellMatrix): string {
  const bits = new Uint8Array(512);
  for (const b of microBoxes(shape, slot)) {
    for (let y = b[1]; y < b[4]; y++)
      for (let z = b[2]; z < b[5]; z++)
        for (let x = b[0]; x < b[3]; x++) {
          // Cell centres about the cell's centre, doubled to stay integer: -7..7.
          const [px, py, pz] = apply(m, [2 * x - 7, 2 * y - 7, 2 * z - 7]);
          bits[((px + 7) >> 1) + ((pz + 7) >> 1) * 8 + ((py + 7) >> 1) * 64] = 1;
        }
  }
  return bits.join("");
}

/**
 * An architecture slot's surface, moved by `m`, as a string that doesn't depend on how its
 * polygons were split into triangles or wound: its corners, and its area in each plane.
 */
function archKey(shape: string, slot: number, m: CellMatrix): string {
  const t = archTriangles(shape, slot);
  const corners = new Set<string>();
  const planes = new Map<string, number>();
  for (let i = 0; i + 8 < t.length; i += 9) {
    const v = [0, 1, 2].map((k) => {
      const p = apply(m, [
        (t[i + k * 3] ?? 0) - 0.5,
        (t[i + k * 3 + 1] ?? 0) - 0.5,
        (t[i + k * 3 + 2] ?? 0) - 0.5,
      ]);
      // Corners sit on a 1/48 grid; rounding absorbs float noise.
      return p.map((c) => Math.round(c * 48)) as [number, number, number];
    }) as [number, number, number][];
    for (const p of v) corners.add(p.join(","));
    const [a, b, c] = v as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
      (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
      (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
      (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
    ];
    const area2 = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
    if (area2 === 0) continue;
    // The plane, unsigned (a mirror flips winding): its unit normal with the first nonzero
    // component positive, and its offset.
    const first = n.find((c) => c !== 0) ?? 1;
    n = n.map((c) => (c * Math.sign(first)) / area2);
    const d = (n[0] ?? 0) * a[0] + (n[1] ?? 0) * a[1] + (n[2] ?? 0) * a[2];
    const plane = [...n, d].map((c) => Math.round(c * 1000)).join(",");
    planes.set(plane, (planes.get(plane) ?? 0) + area2);
  }
  const areas = [...planes].map(([p, area]) => `${p}:${Math.round(area)}`).sort();
  return `${[...corners].sort().join(";")}|${areas.join(";")}`;
}

function archSlotOf(r: CellMatrix): number | null {
  const key = r.join(",");
  for (let s = 0; s < ARCH_SLOTS; s++) {
    if (archRotation(s >> 2, s & 3).join(",") === key) return s;
  }
  return null;
}

function apply(m: CellMatrix, v: readonly [number, number, number]): [number, number, number] {
  return [
    (m[0] ?? 0) * v[0] + (m[1] ?? 0) * v[1] + (m[2] ?? 0) * v[2],
    (m[3] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[5] ?? 0) * v[2],
    (m[6] ?? 0) * v[0] + (m[7] ?? 0) * v[1] + (m[8] ?? 0) * v[2],
  ];
}

function mul(a: CellMatrix, b: CellMatrix): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += (a[r * 3 + k] ?? 0) * (b[k * 3 + c] ?? 0);
      out.push(s);
    }
  return out;
}

function det(m: CellMatrix): number {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}
