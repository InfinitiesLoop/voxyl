// Microblocks: sub-block parts on an 8 x 8 x 8 grid, several to a cell (Forge Microblocks'
// covers, panels, slabs, hollow covers, strips, posts, pillars, nooks, corners and notches).
// Ported from the Godot app's ShapeCatalog.gd, which follows the mod's slot numbering so a
// build exports 1:1; the ids and names are plain geometry words, nothing Minecraft-specific.
//
// Sides: 0 -Y, 1 +Y, 2 -Z, 3 +Z, 4 -X, 5 +X (side >> 1 is the axis group: 0 Y, 1 Z, 2 X).
// Slots by family:
//   face, hollow   slot = the side the part lies against (6).
//   corner         slot 0-7, bits 1 = +Y, 2 = +Z, 4 = +X.
//   edge           slot 0-11: 0-3 run along Y (bit 0 +Z, bit 1 +X), 4-7 along Z (bit 0 +X,
//                  bit 1 +Y), 8-11 along X (bit 0 +Y, bit 1 +Z). Even sizes add centered
//                  posts: slot 12 + axis group (12 Y, 13 Z, 14 X).

export type MicroFamily = "face" | "hollow" | "edge" | "corner";

export interface MicroShape {
  readonly name: string;
  readonly family: MicroFamily;
  /** Thickness in eighths of a cell. */
  readonly size: number;
}

export const MICRO_SHAPES: Readonly<Record<string, MicroShape>> = {
  face1: { name: "Cover", family: "face", size: 1 },
  face2: { name: "Panel", family: "face", size: 2 },
  face4: { name: "Slab", family: "face", size: 4 },
  hollow1: { name: "Hollow Cover", family: "hollow", size: 1 },
  hollow2: { name: "Hollow Panel", family: "hollow", size: 2 },
  hollow4: { name: "Hollow Slab", family: "hollow", size: 4 },
  edge1: { name: "Strip", family: "edge", size: 1 },
  edge2: { name: "Post", family: "edge", size: 2 },
  edge4: { name: "Pillar", family: "edge", size: 4 },
  corner1: { name: "Nook", family: "corner", size: 1 },
  corner2: { name: "Corner", family: "corner", size: 2 },
  corner4: { name: "Notch", family: "corner", size: 4 },
};

/** The first centered-post slot of an edge shape: 12 + axis group. */
export const CENTER_SLOT = 12;

/** A box in eighths of a cell: [x0, y0, z0, x1, y1, z1], each 0..8. */
export type Box8 = readonly [number, number, number, number, number, number];

/** The vector component (0 x, 1 y, 2 z) of each axis group (0 Y, 1 Z, 2 X). */
const AXIS_COMPONENT = [1, 2, 0] as const;
/** The slot bit of each component: x 4, y 1, z 2. */
const COMPONENT_BIT = [4, 1, 2] as const;

export function microSlotCount(shape: string): number {
  const s = MICRO_SHAPES[shape];
  if (!s) return 0;
  if (s.family === "face" || s.family === "hollow") return 6;
  if (s.family === "corner") return 8;
  return s.size % 2 === 0 ? 15 : 12;
}

/** The side (0..5) whose outward direction is `sign` along component `component`. */
export function sideOf(component: 0 | 1 | 2, sign: 1 | -1): number {
  const group = AXIS_COMPONENT.indexOf(component);
  return group * 2 + (sign > 0 ? 1 : 0);
}

/** The edge (0..11) between two sides on different axes. */
export function edgeBetween(s1: number, s2: number): number {
  const bitsFor = (side: number) => (side & 1 ? COMPONENT_BIT[AXIS_COMPONENT[side >> 1] ?? 0] : 0);
  const c1 = AXIS_COMPONENT[s1 >> 1] ?? 0;
  const c2 = AXIS_COMPONENT[s2 >> 1] ?? 0;
  if (c1 === c2) throw new RangeError(`Sides ${s1} and ${s2} share an axis`);
  const along = 3 - c1 - c2; // the remaining component
  const group = AXIS_COMPONENT.indexOf(along as 0 | 1 | 2);
  return packEdgeBits(group * 4, bitsFor(s1) | bitsFor(s2));
}

/** Axis bits (x 4, y 1, z 2) of the positive sides edge `e` (0..11) touches. */
function unpackEdgeBits(e: number): number {
  switch (e >> 2) {
    case 0:
      return (e & 3) << 1;
    case 1:
      return ((e & 2) >> 1) | ((e & 1) << 2);
    default:
      return e & 3;
  }
}

function packEdgeBits(e: number, bits: number): number {
  switch (e >> 2) {
    case 0:
      return (e & 0xc) | (bits >> 1);
    case 1:
      return (e & 0xc) | ((bits & 4) >> 2) | ((bits & 1) << 1);
    default:
      return (e & 0xc) | (bits & 3);
  }
}

/** The boxes a placed microblock fills, or [] for an unknown shape or slot. */
export function microBoxes(shape: string, slot: number): Box8[] {
  const s = MICRO_SHAPES[shape];
  if (!s || !Number.isInteger(slot) || slot < 0 || slot >= microSlotCount(shape)) return [];
  const d = s.size;
  switch (s.family) {
    case "face":
      return [faceBox(slot, d)];
    case "hollow":
      return ringBoxes(slot, d);
    case "corner":
      return [cornerBox(slot, d)];
    case "edge":
      return [slot >= CENTER_SLOT ? postBox(slot - CENTER_SLOT, d) : edgeBox(slot, d)];
  }
}

function box(lo: number[], hi: number[]): Box8 {
  return [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0, hi[0] ?? 8, hi[1] ?? 8, hi[2] ?? 8];
}

/** A slab `d` thick against `side`. */
function faceBox(side: number, d: number): Box8 {
  const lo = [0, 0, 0];
  const hi = [8, 8, 8];
  const c = AXIS_COMPONENT[side >> 1] ?? 0;
  if (side & 1) lo[c] = 8 - d;
  else hi[c] = d;
  return box(lo, hi);
}

/** A face slab with a centered half-cell hole, as four boxes. */
function ringBoxes(side: number, d: number): Box8[] {
  const slab = faceBox(side, d);
  const c = AXIS_COMPONENT[side >> 1] ?? 0;
  const p = (c + 1) % 3;
  const q = (c + 2) % 3;
  const bands = [
    [0, 8, 0, 2],
    [0, 8, 6, 8],
    [0, 2, 2, 6],
    [6, 8, 2, 6],
  ] as const;
  return bands.map(([p0, p1, q0, q1]) => {
    const lo = [slab[0], slab[1], slab[2]];
    const hi = [slab[3], slab[4], slab[5]];
    lo[p] = p0;
    hi[p] = p1;
    lo[q] = q0;
    hi[q] = q1;
    return box(lo, hi);
  });
}

function cornerBox(corner: number, d: number): Box8 {
  const lo = [0, 0, 0];
  const hi = [d, d, d];
  for (let c = 0; c < 3; c++) {
    if (corner & (COMPONENT_BIT[c] ?? 0)) {
      lo[c] = 8 - d;
      hi[c] = 8;
    }
  }
  return box(lo, hi);
}

function edgeBox(e: number, d: number): Box8 {
  const along = AXIS_COMPONENT[e >> 2] ?? 0;
  const bits = unpackEdgeBits(e);
  const lo = [0, 0, 0];
  const hi = [8, 8, 8];
  for (let c = 0; c < 3; c++) {
    if (c === along) continue;
    if (bits & (COMPONENT_BIT[c] ?? 0)) lo[c] = 8 - d;
    else hi[c] = d;
  }
  return box(lo, hi);
}

/** A centered post `d` wide along axis group `group`. */
function postBox(group: number, d: number): Box8 {
  const along = AXIS_COMPONENT[group] ?? 0;
  const lo = [4 - d / 2, 4 - d / 2, 4 - d / 2];
  const hi = [4 + d / 2, 4 + d / 2, 4 + d / 2];
  lo[along] = 0;
  hi[along] = 8;
  return box(lo, hi);
}
