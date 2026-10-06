// Where a command acts (web-core.md, section 5): one region expression language shared by every
// command, the selection and the editor. A region is a set of positions, empty or not, and
// evaluates to exact cells (a CellSet), never to a bounding box.
//
//   { box: [x0, y0, z0, x1, y1, z1] }                  corners inclusive, any order
//   { selection: true }                                the project's selection
//   { palette: id, descendants?, within? }             cells of a group (a palette's semantics)
//   { semantic: ref, within? }                         cells holding a semantic (block or part)
//   { structure: { seed, semantics?, diagonal? }, within? }   connected cells from a seed
//   { all: [...] }  { any: [...] }  { not: r }         intersection, union; not only inside all
//   { grow: n, of: r }  { shrink: n, of: r }           through faces, n steps

import { z } from "zod";
import { type Box, boxOf, boxVolume } from "./box.ts";
import { type CellState, semanticsOf } from "./cell-state.ts";
import { CellSet } from "./cellset.ts";
import type { PaletteId, SemanticId, SemanticRegistry } from "./semantics.ts";
import type { World } from "./world.ts";

/** Regions searched without a `within` look at most this far from their seed. */
export const DEFAULT_REACH = 256;
/** A region larger than this is refused (a typo'd box shouldn't eat the tab's memory). */
export const MAX_REGION_CELLS = 64_000_000;

const Coord = z.number().int();
const Id = z.number().int().positive();
const Steps = z.number().int().min(1).max(64);

/** Two opposite corners, inclusive, in any order: [x0, y0, z0, x1, y1, z1]. */
export const BoxArg = z.tuple([Coord, Coord, Coord, Coord, Coord, Coord]);
export const PosArg = z.tuple([Coord, Coord, Coord]);
const SemanticRef = z.union([Id, z.strictObject({ palette: Id, base: Id })]);

export type Region =
  | { box: [number, number, number, number, number, number] }
  | { selection: true }
  | { palette: number; descendants?: boolean | undefined; within?: Region | undefined }
  | { semantic: SemanticRef; within?: Region | undefined }
  | {
      structure: {
        seed: [number, number, number];
        semantics?: SemanticRef[] | undefined;
        diagonal?: boolean | undefined;
      };
      within?: Region | undefined;
    }
  | { all: Region[] }
  | { any: Region[] }
  | { not: Region }
  | { grow: number; of: Region }
  | { shrink: number; of: Region };
type SemanticRef = number | { palette: number; base: number };

export const Region: z.ZodType<Region> = z.lazy(() =>
  z.union([
    z.strictObject({ box: BoxArg }),
    z.strictObject({ selection: z.literal(true) }),
    z.strictObject({ palette: Id, descendants: z.boolean().optional(), within: Region.optional() }),
    z.strictObject({ semantic: SemanticRef, within: Region.optional() }),
    z.strictObject({
      structure: z.strictObject({
        seed: PosArg,
        semantics: z.array(SemanticRef).min(1).optional(),
        diagonal: z.boolean().optional(),
      }),
      within: Region.optional(),
    }),
    z.strictObject({ all: z.array(Region).min(1) }),
    z.strictObject({ any: z.array(Region).min(1) }),
    z.strictObject({ not: Region }),
    z.strictObject({ grow: Steps, of: Region }),
    z.strictObject({ shrink: Steps, of: Region }),
  ]),
);

/** What evaluating a region reads. */
export interface RegionScope {
  readonly world: World;
  readonly semantics: SemanticRegistry;
  readonly selection: CellSet | null;
  /** Resolves a semantic reference (deriving on first use, like any command argument). */
  semantic(ref: SemanticRef): SemanticId;
}

export class RegionError extends Error {
  override readonly name = "RegionError";
}

/** The box when a region is a plain box (commands use it for fast paths), else null. */
export function plainBox(region: Region): Box | null {
  return "box" in region ? boxOf(region.box) : null;
}

/** The exact cells of a region. */
export function evaluate(region: Region, scope: RegionScope): CellSet {
  const set = evaluateInner(region, scope);
  if (set.size > MAX_REGION_CELLS) {
    throw new RegionError(`The region holds ${set.size} cells (limit ${MAX_REGION_CELLS})`);
  }
  return set;
}

function evaluateInner(region: Region, scope: RegionScope): CellSet {
  if ("box" in region) {
    const box = boxOf(region.box);
    const volume = boxVolume(box);
    if (volume > MAX_REGION_CELLS) {
      throw new RegionError(`The box holds ${volume} cells (limit ${MAX_REGION_CELLS})`);
    }
    return CellSet.ofBox(box);
  }
  if ("selection" in region) return scope.selection?.clone() ?? new CellSet();
  if ("palette" in region) {
    const group = scope.semantics.semanticsIn(
      checkPalette(scope, region.palette),
      region.descendants ?? false,
    );
    return matching(scope, new Set(group), region.within);
  }
  if ("semantic" in region) {
    return matching(scope, new Set([scope.semantic(region.semantic)]), region.within);
  }
  if ("structure" in region) return structure(region, scope);
  if ("all" in region) {
    const positive = region.all.filter((r) => !("not" in r));
    if (positive.length === 0)
      throw new RegionError("all needs at least one region that isn't a not");
    const [first, ...rest] = positive;
    const set = evaluateInner(first as Region, scope);
    for (const r of rest) set.retainAll(evaluateInner(r, scope));
    for (const r of region.all) if ("not" in r) set.removeAll(evaluateInner(r.not, scope));
    return set;
  }
  if ("any" in region) {
    const set = new CellSet();
    for (const r of region.any) set.addAll(evaluateInner(r, scope));
    return set;
  }
  if ("not" in region) throw new RegionError("not only works inside all, to subtract");
  if ("grow" in region) return evaluateInner(region.of, scope).grown(region.grow);
  return evaluateInner(region.of, scope).shrunk(region.shrink);
}

function checkPalette(scope: RegionScope, id: PaletteId): PaletteId {
  if (!scope.semantics.hasPalette(id)) throw new RegionError(`Unknown palette id ${id}`);
  return id;
}

/** Occupied cells holding any of the semantics (as a block or a part), within a region. */
function matching(
  scope: RegionScope,
  semantics: ReadonlySet<SemanticId>,
  within: Region | undefined,
): CellSet {
  const { world } = scope;
  const states = world.states;
  // Per state id: does it hold one of the semantics? Filled lazily.
  const memo = new Map<number, boolean>();
  const matches = (id: number) => {
    let m = memo.get(id);
    if (m === undefined) {
      const state: CellState | null = states.get(id);
      m = state !== null && semanticsOf(state).some((s) => semantics.has(s));
      memo.set(id, m);
    }
    return m;
  };
  const out = new CellSet();
  if (within) {
    evaluateInner(within, scope).forEach((x, y, z) => {
      const id = world.getId(x, y, z);
      if (id !== 0 && matches(id)) out.add(x, y, z);
    });
  } else {
    world.forEachCell((x, y, z, id) => {
      if (matches(id)) out.add(x, y, z);
    });
  }
  return out;
}

/**
 * Occupied cells connected to the seed through faces (or edges and corners too, with
 * `diagonal`), holding one of the given semantics (any, if none given), inside `within` or
 * DEFAULT_REACH cells of the seed. The seed itself must qualify, or the result is empty.
 */
function structure(region: Extract<Region, { structure: unknown }>, scope: RegionScope): CellSet {
  const { seed, semantics, diagonal = false } = region.structure;
  const { world } = scope;
  const allowed = semantics ? new Set(semantics.map((s) => scope.semantic(s))) : null;
  const [sx, sy, sz] = seed;
  const limit = region.within
    ? evaluateInner(region.within, scope)
    : CellSet.ofBox({
        x0: sx - DEFAULT_REACH,
        y0: sy - DEFAULT_REACH,
        z0: sz - DEFAULT_REACH,
        x1: sx + DEFAULT_REACH,
        y1: sy + DEFAULT_REACH,
        z1: sz + DEFAULT_REACH,
      });
  const memo = new Map<number, boolean>();
  const ok = (x: number, y: number, z: number) => {
    if (!limit.has(x, y, z) || !world.layout.isWorldCoord(x) || !world.layout.isWorldCoord(y))
      return false;
    if (!world.layout.isWorldCoord(z)) return false;
    const id = world.getId(x, y, z);
    if (id === 0) return false;
    if (!allowed) return true;
    let m = memo.get(id);
    if (m === undefined) {
      const state = world.states.get(id);
      m = state !== null && semanticsOf(state).some((s) => allowed.has(s));
      memo.set(id, m);
    }
    return m;
  };
  const out = new CellSet();
  if (!ok(sx, sy, sz)) return out;
  const offsets: [number, number, number][] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (n === 1 || (diagonal && n > 1)) offsets.push([dx, dy, dz]);
      }
  const queue: number[] = [sx, sy, sz];
  out.add(sx, sy, sz);
  for (let head = 0; head < queue.length; head += 3) {
    const x = queue[head] ?? 0;
    const y = queue[head + 1] ?? 0;
    const z = queue[head + 2] ?? 0;
    for (const [dx, dy, dz] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (out.has(nx, ny, nz) || !ok(nx, ny, nz)) continue;
      out.add(nx, ny, nz);
      queue.push(nx, ny, nz);
    }
    if (out.size > MAX_REGION_CELLS) {
      throw new RegionError(`The structure grew past ${MAX_REGION_CELLS} cells`);
    }
  }
  return out;
}
