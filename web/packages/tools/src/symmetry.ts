// Symmetry and repeat for edit tools (ported from Godot's SpatialXform). An edit is copied
// through every map of a symmetry group, then through every step of a repeat. A map is a
// signed permutation (a quarter turn about Y, a mirror) with an integer shift, acting on cell
// positions; the cell (x, y, z) sits at the point (x, y, z), so a centre at .5 is a boundary.
//
// Regions move as boxes: a plain box maps to a box, any other region is evaluated to its
// cells first and covered by boxes. A cell's state moves with it: a block's rotation turns, a
// part's slot moves to the slot its geometry lands in (a part with no mirror image is left out).

import {
  applyMatrix,
  type Box,
  type CellSet,
  type CellStateArg,
  type Project,
  placementMatrix,
  type Region,
  transformRotation,
} from "@voxyl/core";
import { transformSlot } from "@voxyl/shapes";
import { z } from "zod";
import { ToolError } from "./tool.ts";

/** Most cells an edit may expand to through symmetry and repeat. */
export const MAX_EXPANDED_CELLS = 500_000;
/** Most images (copies of an edit) symmetry and repeat make together. */
export const MAX_IMAGES = 4096;
/** Most boxes a scattered region may be covered by when it is moved. */
const MAX_BOXES = 50_000;

const Center = z
  .tuple([z.number(), z.number()])
  .describe("[x, z] in cell coordinates; .5 is the boundary between two cells.");

export const SymmetryArg = z.strictObject({
  rotate4: Center.optional().describe("Four quarter turns about a vertical axis through [x, z]."),
  rotate2: Center.optional().describe("A half turn about a vertical axis through [x, z]."),
  mirror_x: z.number().optional().describe("Reflect across the plane x = this (east/west)."),
  mirror_z: z.number().optional().describe("Reflect across the plane z = this (north/south)."),
});

export const RepeatArg = z.strictObject({
  count: z
    .union([
      z.number().int().min(1),
      z.tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)]),
    ])
    .describe("Copies in a line (n), or per axis [nx, ny, nz] for a grid."),
  step: z
    .tuple([z.number().int(), z.number().int(), z.number().int()])
    .describe("[dx, dy, dz] between copies."),
});

/** The fields edit tools take to copy an edit around (spread into their input). */
export const EditExtras = {
  symmetry: SymmetryArg.optional().describe(
    "Copy the edit through a symmetry group, e.g. {rotate4:[8.5,8.5]} (centres are cell coordinates; .5 = a boundary). Design one quarter and let this fill the rest.",
  ),
  repeat: RepeatArg.optional().describe(
    "Copy the edit in an array after symmetry: {count:n|[nx,ny,nz], step:[dx,dy,dz]}.",
  ),
};

export interface ExtrasArgs {
  readonly symmetry?: z.output<typeof SymmetryArg> | undefined;
  readonly repeat?: z.output<typeof RepeatArg> | undefined;
}

/** A rigid move of cells: p -> m * p + t. */
export interface Image {
  readonly m: readonly number[];
  readonly t: readonly [number, number, number];
}

const IDENTITY_IMAGE: Image = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

const key = (i: Image) => `${i.m.join(",")}|${i.t.join(",")}`;

const compose = (outer: Image, inner: Image): Image => {
  const [x, y, z] = applyMatrix(outer.m, inner.t);
  const m = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++)
        m[r * 3 + c] = (m[r * 3 + c] ?? 0) + (outer.m[r * 3 + k] ?? 0) * (inner.m[k * 3 + c] ?? 0);
    }
  return { m, t: [x + outer.t[0], y + outer.t[1], z + outer.t[2]] };
};

/** The map p -> M (p - pivot) + pivot, which must send cells to cells. */
function about(name: string, m: number[], pivot: [number, number, number]): Image {
  const [px, py, pz] = applyMatrix(m, pivot);
  const t = [pivot[0] - px, pivot[1] - py, pivot[2] - pz];
  if (t.some((v) => Math.abs(v - Math.round(v)) > 1e-9)) {
    throw new ToolError(
      "bad_argument",
      `symmetry.${name}: that centre puts cells between cells. For a quarter turn use a centre like [8, 8] or [8.5, 8.5]; both coordinates must be whole, or both end in .5.`,
    );
  }
  return { m, t: [Math.round(t[0] ?? 0), Math.round(t[1] ?? 0), Math.round(t[2] ?? 0)] };
}

/**
 * Every image of an edit: the symmetry group's maps (identity first), each shifted by every
 * step of the repeat. Always at least the identity.
 */
export function planImages(extras: ExtrasArgs): Image[] {
  const gens: Image[] = [];
  const sym = extras.symmetry;
  if (sym?.rotate4)
    gens.push(about("rotate4", placementMatrix(1), [sym.rotate4[0], 0, sym.rotate4[1]]));
  if (sym?.rotate2)
    gens.push(about("rotate2", placementMatrix(2), [sym.rotate2[0], 0, sym.rotate2[1]]));
  if (sym?.mirror_x !== undefined)
    gens.push(about("mirror_x", placementMatrix(0, "x"), [sym.mirror_x, 0, 0]));
  if (sym?.mirror_z !== undefined)
    gens.push(about("mirror_z", placementMatrix(0, "z"), [0, 0, sym.mirror_z]));
  const group: Image[] = [IDENTITY_IMAGE];
  const seen = new Set([key(IDENTITY_IMAGE)]);
  let frontier = [...group];
  while (frontier.length > 0 && group.length < 16) {
    const next: Image[] = [];
    for (const m of frontier)
      for (const g of gens) {
        const c = compose(g, m);
        if (!seen.has(key(c))) {
          seen.add(key(c));
          group.push(c);
          next.push(c);
        }
      }
    frontier = next;
  }

  const offsets: [number, number, number][] = [];
  const rep = extras.repeat;
  if (rep) {
    const [sx, sy, sz] = rep.step;
    const [nx, ny, nz] = typeof rep.count === "number" ? [rep.count, 1, 1] : rep.count;
    if (nx * ny * nz * group.length > MAX_IMAGES) {
      throw new ToolError(
        "too_large",
        `symmetry and repeat make ${nx * ny * nz * group.length} copies (limit ${MAX_IMAGES}).`,
      );
    }
    if (typeof rep.count === "number") {
      for (let i = 0; i < nx; i++) offsets.push([i * sx, i * sy, i * sz]);
    } else {
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++)
          for (let k = 0; k < nz; k++) offsets.push([i * sx, j * sy, k * sz]);
    }
  } else {
    offsets.push([0, 0, 0]);
  }
  const out: Image[] = [];
  const done = new Set<string>();
  for (const [dx, dy, dz] of offsets)
    for (const g of group) {
      const image: Image = { m: g.m, t: [g.t[0] + dx, g.t[1] + dy, g.t[2] + dz] };
      if (!done.has(key(image))) {
        done.add(key(image));
        out.push(image);
      }
    }
  return out;
}

/** Whether the edit is copied at all. */
export const isExpanded = (images: readonly Image[]) => images.length > 1;

/** Refuses an edit that would expand past the cap. */
export function checkExpansion(images: readonly Image[], cells: number): void {
  if (images.length * cells > MAX_EXPANDED_CELLS) {
    throw new ToolError(
      "too_large",
      `The edit would touch ${images.length * cells} cells through ${images.length} copies (limit ${MAX_EXPANDED_CELLS}). Use a smaller region or fewer copies.`,
    );
  }
}

export function movePos(
  image: Image,
  p: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = applyMatrix(image.m, [p[0], p[1], p[2]]);
  return [x + image.t[0], y + image.t[1], z + image.t[2]];
}

export function moveBox(image: Image, box: Box): Box {
  const [ax, ay, az] = movePos(image, [box.x0, box.y0, box.z0]);
  const [bx, by, bz] = movePos(image, [box.x1, box.y1, box.z1]);
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    z0: Math.min(az, bz),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
    z1: Math.max(az, bz),
  };
}

/** A cell state moved by an image (null, a clear, stays); undefined when a part has no image. */
export function moveState(
  image: Image,
  state: CellStateArg | null,
): CellStateArg | null | undefined {
  if (state === null) return null;
  if (state.parts) {
    const parts: NonNullable<CellStateArg["parts"]> = [];
    for (const p of state.parts) {
      const slot = transformSlot(p.shape, p.slot, image.m);
      if (slot === null) return undefined;
      parts.push({ ...p, slot });
    }
    return { ...state, parts };
  }
  if (image.m.every((v, i) => v === (i % 4 === 0 ? 1 : 0))) return state;
  const rotation = transformRotation(state.rotation ?? 0, image.m);
  const { rotation: _, ...rest } = state;
  return rotation === 0 ? rest : { ...rest, rotation };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The boxes that cover exactly a set of cells (rows merged along x, then z, then y). */
export function cellsToBoxes(set: CellSet): Box[] {
  const rows: { y: number; z: number; x0: number; x1: number }[] = [];
  for (const b of set.bricks()) {
    for (let dy = 0; dy < 8; dy++)
      for (let dz = 0; dz < 8; dz++) {
        let start = -1;
        for (let dx = 0; dx <= 8; dx++) {
          const has = dx < 8 && (b.full || b.has(dx + dz * 8 + dy * 64));
          if (has && start < 0) start = dx;
          else if (!has && start >= 0) {
            rows.push({ y: b.y + dy, z: b.z + dz, x0: b.x + start, x1: b.x + dx - 1 });
            start = -1;
          }
        }
      }
  }
  // Join runs that touch along x across brick edges.
  rows.sort((a, b) => a.y - b.y || a.z - b.z || a.x0 - b.x0);
  const runs: typeof rows = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && last.y === r.y && last.z === r.z && last.x1 + 1 === r.x0) last.x1 = r.x1;
    else runs.push({ ...r });
  }
  // Rows with the same x range and consecutive z join into slabs of z, then consecutive y.
  runs.sort((a, b) => a.y - b.y || a.x0 - b.x0 || a.x1 - b.x1 || a.z - b.z);
  const slabs: Mutable<Box>[] = [];
  for (const r of runs) {
    const last = slabs[slabs.length - 1];
    if (last && last.y0 === r.y && last.x0 === r.x0 && last.x1 === r.x1 && last.z1 + 1 === r.z) {
      last.z1 = r.z;
    } else slabs.push({ x0: r.x0, x1: r.x1, y0: r.y, y1: r.y, z0: r.z, z1: r.z });
  }
  slabs.sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1 || a.z0 - b.z0 || a.z1 - b.z1 || a.y0 - b.y0);
  const boxes: Mutable<Box>[] = [];
  for (const s of slabs) {
    const last = boxes[boxes.length - 1];
    if (
      last &&
      last.x0 === s.x0 &&
      last.x1 === s.x1 &&
      last.z0 === s.z0 &&
      last.z1 === s.z1 &&
      last.y1 + 1 === s.y0
    ) {
      last.y1 = s.y1;
    } else boxes.push({ ...s });
  }
  return boxes;
}

/** Maps regions through images; evaluates each distinct region once. */
export class RegionMover {
  readonly #project: Project;
  readonly #boxes = new Map<Region, Box[]>();

  constructor(project: Project) {
    this.#project = project;
  }

  boxesOf(region: Region): Box[] {
    let boxes = this.#boxes.get(region);
    if (!boxes) {
      if ("box" in region) {
        const [a, b, c, d, e, f] = region.box;
        boxes = [
          {
            x0: Math.min(a, d),
            y0: Math.min(b, e),
            z0: Math.min(c, f),
            x1: Math.max(a, d),
            y1: Math.max(b, e),
            z1: Math.max(c, f),
          },
        ];
      } else {
        boxes = cellsToBoxes(this.#project.cells(region));
      }
      this.#boxes.set(region, boxes);
    }
    return boxes;
  }

  /** The cells of a region, counted (for the expansion cap). */
  sizeOf(region: Region): number {
    if ("box" in region) {
      const [b] = this.boxesOf(region);
      return b ? (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1) : 0;
    }
    return this.#project.cells(region).size;
  }

  /** The region an image sends `region` to, or null when the region holds no cells. */
  move(image: Image, region: Region): Region | null {
    const boxes = this.boxesOf(region);
    if (boxes.length > MAX_BOXES) {
      throw new ToolError(
        "too_large",
        "That region is too scattered to copy through symmetry or repeat; use a simpler region.",
      );
    }
    const moved = boxes.map((b) => {
      const m = moveBox(image, b);
      return {
        box: [m.x0, m.y0, m.z0, m.x1, m.y1, m.z1] as [
          number,
          number,
          number,
          number,
          number,
          number,
        ],
      };
    });
    if (moved.length === 0) return null;
    return moved.length === 1 ? (moved[0] as Region) : { any: moved };
  }
}

/** Counts for a result: how many copies, and whether any were left out. */
export function expansionNotes(images: readonly Image[], skipped: number): Record<string, unknown> {
  return {
    ...(images.length > 1 && { copies: images.length }),
    ...(skipped > 0 && { copies_skipped: skipped }),
  };
}

interface RegionArgs {
  readonly where: Region;
  readonly state?: CellStateArg | null;
}

/**
 * Copies region commands (fill, clear, resemantic: anything with `where`, and a `state` for
 * fill) through the images, one image's commands after another's. The first image is the
 * identity, so its commands stay as they are. Images whose state has no image (a part with no
 * mirror twin), or whose region is empty, are left out and counted.
 */
export function expandRegionSpecs(
  project: Project,
  images: readonly Image[],
  specs: readonly { kind: string; args: unknown }[],
): { specs: { kind: string; args: unknown }[]; skipped: number } {
  if (!isExpanded(images)) return { specs: [...specs], skipped: 0 };
  const mover = new RegionMover(project);
  let cells = 0;
  const seen = new Set<Region>();
  for (const s of specs) {
    const where = (s.args as RegionArgs).where;
    if (!seen.has(where)) {
      seen.add(where);
      cells += mover.sizeOf(where);
    }
  }
  checkExpansion(images, cells);
  const out: { kind: string; args: unknown }[] = [];
  let skipped = 0;
  images.forEach((image, i) => {
    const copy: { kind: string; args: unknown }[] = [];
    for (const s of specs) {
      if (i === 0) {
        copy.push(s);
        continue;
      }
      const args = s.args as RegionArgs & Record<string, unknown>;
      const where = mover.move(image, args.where);
      const state = args.state === undefined ? null : moveState(image, args.state);
      if (where === null || state === undefined) {
        copy.length = 0;
        skipped++;
        break;
      }
      copy.push({ kind: s.kind, args: { ...args, where, ...(state !== null && { state }) } });
    }
    out.push(...copy);
  });
  return { specs: out, skipped };
}
