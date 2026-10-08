// A piece: cells lifted out of a project to be placed elsewhere, as the clipboard and prefabs
// hold them (web-core.md, sections 1 and 8). It carries what it needs to land anywhere: its
// cells, the states they hold, the semantics those use (by name and palette, with their look,
// so a piece renders the same in a project that has never seen them), and its north.
//
// Cells are run-length encoded over the piece's box, x fastest, then z, then y, as pairs
// [index, run]: index 0 is outside the piece (never written), k is states[k - 1], and a null
// state is air (an empty cell that clears what's under it when the paste asks for it). A
// state's semantic numbers are 1-based indices into `semantics`.

import { z } from "zod";
import type { CellSet } from "./cellset.ts";
import { defined, FormArg, LookArg, NameArg } from "./commands/command.ts";
import { type StateJSON, stateJSON } from "./format/state-json.ts";
import { MAX_REGION_CELLS, PosArg } from "./region.ts";
import type { Form, Look, PaletteId, SemanticId, SemanticRegistry } from "./semantics.ts";
import { ROOT_PALETTE } from "./semantics.ts";
import { type Direction, DirectionArg } from "./transform.ts";
import type { World } from "./world.ts";

/** A semantic as a piece carries it: resolved, so it needs nothing else from its project. */
export interface PieceSemantic {
  readonly name: string;
  /** The name of the palette it lives in (its group). */
  readonly palette: string;
  readonly description?: string | undefined;
  readonly form?: Form | undefined;
  readonly look?: Look | undefined;
  /** Its id in the project the piece came from (`origin`). */
  readonly id?: number | undefined;
}

export interface Piece {
  /** The box the cells fill, from [0, 0, 0]. */
  readonly size: readonly [number, number, number];
  /** Which of the piece's directions is the real north (its source project's north). */
  readonly north: Direction;
  /** The cell a paste puts at its target, and turns about. Default [0, 0, 0]. */
  readonly anchor?: readonly [number, number, number] | undefined;
  /** The id of the project it was cut from: semantics map back by id there. */
  readonly origin?: string | undefined;
  readonly semantics: readonly PieceSemantic[];
  readonly states: readonly (StateJSON | null)[];
  readonly cells: readonly number[];
}

const Dim = z.number().int().min(1).max(4096);
const Index = z.number().int().min(0);
const Rot = z.number().int().min(0).max(23);
const Tags = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const StateJSONArg = z.union([
  z.tuple([Index, Rot]),
  z.tuple([Index, Rot, Tags]),
  z.tuple([Index, Rot, Tags, z.array(z.tuple([Index, z.string().min(1), Index])).min(1)]),
]);

export const PieceArg = z
  .strictObject({
    size: z.tuple([Dim, Dim, Dim]),
    north: DirectionArg,
    anchor: PosArg.optional(),
    origin: z.string().min(1).optional(),
    semantics: z.array(
      z.strictObject({
        name: NameArg,
        palette: NameArg,
        description: z.string().optional(),
        form: FormArg.optional(),
        look: LookArg.optional(),
        id: z.number().int().positive().optional(),
      }),
    ),
    states: z.array(StateJSONArg.nullable()),
    cells: z.array(Index),
  })
  .refine((p) => p.size[0] * p.size[1] * p.size[2] <= MAX_REGION_CELLS, {
    message: `a piece holds at most ${MAX_REGION_CELLS} cells`,
  });

/**
 * Lifts the cells of a region out of a world into a piece, or null if the region is empty.
 * Empty cells of the region come along as air.
 */
export function cutPiece(
  source: { world: World; semantics: SemanticRegistry; id?: string; north: Direction },
  cells: CellSet,
  anchor?: readonly [number, number, number],
): Piece | null {
  const b = cells.bounds();
  if (!b) return null;
  const { world, semantics } = source;
  const stateIndex = new Map<number, number>(); // world state id -> piece state number
  const states: (StateJSON | null)[] = [];
  const semanticIndex = new Map<SemanticId, number>();
  const pieceSemantics: PieceSemantic[] = [];
  const semanticNumber = (id: SemanticId): number => {
    let n = semanticIndex.get(id);
    if (n === undefined) {
      const r = semantics.resolve(id);
      pieceSemantics.push({
        name: r.name,
        palette: semantics.palette(r.palette).name,
        ...(r.description !== undefined && { description: r.description }),
        ...(Object.keys(r.form).length > 0 && { form: r.form }),
        ...(Object.keys(r.look).length > 0 && { look: r.look }),
        id,
      });
      n = pieceSemantics.length;
      semanticIndex.set(id, n);
    }
    return n;
  };
  const numberOf = (id: number): number => {
    let n = stateIndex.get(id);
    if (n === undefined) {
      const state = world.states.get(id);
      states.push(state ? stateJSON(state, semanticNumber) : null);
      n = states.length;
      stateIndex.set(id, n);
    }
    return n;
  };

  const runs: number[] = [];
  let current = -1;
  let run = 0;
  for (let y = b.y0; y <= b.y1; y++)
    for (let z = b.z0; z <= b.z1; z++)
      for (let x = b.x0; x <= b.x1; x++) {
        const n = cells.has(x, y, z) ? numberOf(world.getId(x, y, z)) : 0;
        if (n === current) run++;
        else {
          if (run > 0) runs.push(current, run);
          current = n;
          run = 1;
        }
      }
  // Trailing cells outside the piece are implied.
  if (run > 0 && current !== 0) runs.push(current, run);

  return {
    size: [b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1],
    north: source.north,
    ...(anchor && { anchor: [anchor[0] - b.x0, anchor[1] - b.y0, anchor[2] - b.z0] }),
    ...(source.id !== undefined && { origin: source.id }),
    semantics: pieceSemantics,
    states,
    cells: runs,
  };
}

/**
 * Visits each cell in a piece (positions from its box's corner) with its state number, 1-based
 * (states[n - 1]; null there is air). Throws on a malformed piece.
 */
export function forEachPieceCell(
  piece: Piece,
  visit: (x: number, y: number, z: number, n: number) => void,
): void {
  const [w, h, d] = piece.size;
  const volume = w * h * d;
  const states = piece.states.length;
  let i = 0;
  for (let r = 0; r < piece.cells.length; r += 2) {
    const n = piece.cells[r] ?? 0;
    const run = piece.cells[r + 1];
    if (run === undefined || run < 1)
      throw new RangeError("A piece's cells must be [index, run] pairs");
    if (n > states) throw new RangeError(`Piece cell index ${n} has no state`);
    if (i + run > volume) throw new RangeError("A piece's cells run past its box");
    if (n === 0) {
      i += run;
      continue;
    }
    for (const end = i + run; i < end; i++) {
      visit(i % w, Math.floor(i / (w * d)), Math.floor(i / w) % d, n);
    }
  }
}

/** How many cells a piece holds (air included). */
export function pieceCellCount(piece: Piece): number {
  let count = 0;
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    if ((piece.cells[r] ?? 0) !== 0) count += piece.cells[r + 1] ?? 0;
  }
  return count;
}

/**
 * The project semantic for each of a piece's semantics (index i for semantics[i]), adding what
 * is missing, deterministically:
 *
 * 1. an explicit mapping (`map`, keyed by the 1-based number) wins;
 * 2. in the project the piece came from, its semantic id, if it still exists;
 * 3. the semantic of that name in the palette of that name, own or derivable;
 * 4. otherwise it is created there with the piece's description, form and look (creating the
 *    palette too), so a pasted prefab looks as it was authored. A linked (read-only) palette
 *    can't take new semantics, so those go to the root palette instead.
 */
export function importSemantics(
  piece: Piece,
  registry: SemanticRegistry,
  projectId: string | undefined,
  mapped: (n: number) => SemanticId | undefined,
): SemanticId[] {
  return piece.semantics.map((s, i) => {
    const explicit = mapped(i + 1);
    if (explicit !== undefined) return explicit;
    if (piece.origin !== undefined && piece.origin === projectId && s.id !== undefined) {
      if (registry.has(s.id)) return s.id;
    }
    let palette: PaletteId =
      registry.paletteByName(s.palette)?.id ?? registry.addPalette(s.palette);
    if (registry.palette(palette).linked) {
      const found = findIn(registry, palette, s.name);
      if (found !== undefined) return found;
      palette = ROOT_PALETTE;
    }
    return (
      findIn(registry, palette, s.name) ??
      registry.add(s.name, {
        palette,
        ...(s.description !== undefined && { description: s.description }),
        ...(s.form !== undefined && { form: defined(s.form) }),
        ...(s.look !== undefined && { look: defined(s.look) }),
      })
    );
  });
}

/** A palette's semantic named `name`: its own, or one it derives (on first use). */
function findIn(
  registry: SemanticRegistry,
  palette: PaletteId,
  name: string,
): SemanticId | undefined {
  const offer = registry.offers(palette).find((o) => o.name === name);
  if (!offer) return undefined;
  return offer.id ?? (offer.base === undefined ? undefined : registry.derive(palette, offer.base));
}

/** True when a piece's state number is air. */
export function isAir(piece: Piece, n: number): boolean {
  return piece.states[n - 1] === null;
}

/** What `filterPiece` leaves out. */
export interface PieceFilter {
  /** Piece semantic numbers (1-based) whose cells and parts are dropped. */
  readonly exclude?: ReadonlySet<number>;
  /** Shrink the box to the cells that remain (air round them goes). */
  readonly trim?: boolean;
}

/**
 * A copy of a piece with some semantics left out: a cell holding only excluded semantics
 * leaves the piece (it is not written at all), and a cell of parts keeps the parts that remain.
 * Semantics nothing uses any more are dropped and the rest renumbered. With `trim` the box
 * shrinks to what remains, and the anchor keeps its cell. Null when nothing is left; the
 * piece itself when there is nothing to do.
 */
export function filterPiece(piece: Piece, filter: PieceFilter): Piece | null {
  const exclude = filter.exclude ?? new Set<number>();
  if (exclude.size === 0 && !filter.trim) return piece;

  // Which states survive, and what they become.
  const kept = new Map<number, StateJSON | null>(); // old number -> new state (semantics still old)
  for (let n = 1; n <= piece.states.length; n++) {
    const state = piece.states[n - 1];
    if (state === null || state === undefined) {
      kept.set(n, null);
      continue;
    }
    const [semantic, rotation, tags, parts] = state;
    if (parts && parts.length > 0) {
      const left = parts.filter((part) => !exclude.has(part[0]));
      if (left.length > 0) kept.set(n, [semantic, rotation, tags ?? {}, left]);
    } else if (!exclude.has(semantic)) {
      kept.set(n, state);
    }
  }
  const used = new Set<number>();
  for (const state of kept.values()) {
    if (!state) continue;
    if (state[3] && state[3].length > 0) for (const part of state[3]) used.add(part[0]);
    else used.add(state[0]);
  }
  if (used.size === 0) return null;
  const renumber = new Map<number, number>();
  const semantics: PieceSemantic[] = [];
  piece.semantics.forEach((semantic, i) => {
    if (!used.has(i + 1)) return;
    semantics.push(semantic);
    renumber.set(i + 1, semantics.length);
  });
  const number = (old: number) => renumber.get(old) ?? 0;
  const states: (StateJSON | null)[] = [];
  const remap = new Map<number, number>(); // old state number -> new state number
  for (const [n, state] of kept) {
    if (!state) {
      states.push(null);
    } else if (state[3] && state[3].length > 0) {
      states.push([
        0,
        state[1],
        state[2] ?? {},
        state[3].map(([p, shape, slot]) => [number(p), shape, slot]),
      ]);
    } else if (state[2]) {
      states.push([number(state[0]), state[1], state[2]]);
    } else {
      states.push([number(state[0]), state[1]]);
    }
    remap.set(n, states.length);
  }

  // The box: all of it, or the one the surviving (non-air) cells fill.
  const [w, h, d] = piece.size;
  let lo: [number, number, number] = [0, 0, 0];
  let hi: [number, number, number] = [w - 1, h - 1, d - 1];
  if (filter.trim) {
    const found = boundsOfRuns(piece, (n) => {
      const state = kept.get(n);
      return state !== undefined && state !== null;
    });
    if (!found) return null;
    lo = found.lo;
    hi = found.hi;
  }
  const nx = hi[0] - lo[0] + 1;
  const ny = hi[1] - lo[1] + 1;
  const nz = hi[2] - lo[2] + 1;

  // Source runs, with where each starts, to read rows of the new box out of the old.
  const starts: number[] = [];
  let at = 0;
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    starts.push(at);
    at += piece.cells[r + 1] ?? 0;
  }
  const cells: number[] = [];
  let current = -1;
  let run = 0;
  const emit = (value: number, count: number) => {
    if (count <= 0) return;
    if (value === current) {
      run += count;
      return;
    }
    if (run > 0) cells.push(current, run);
    current = value;
    run = count;
  };
  let r = 0;
  for (let y = lo[1]; y <= hi[1]; y++) {
    for (let z = lo[2]; z <= hi[2]; z++) {
      const from = (y * d + z) * w + lo[0];
      const to = from + nx;
      while (r < starts.length && (starts[r] ?? 0) + (piece.cells[r * 2 + 1] ?? 0) <= from) r++;
      let cursor = from;
      for (let k = r; cursor < to; k++) {
        if (k >= starts.length) {
          emit(0, to - cursor);
          break;
        }
        const first = Math.max(starts[k] ?? 0, cursor);
        if (first > cursor) emit(0, first - cursor); // a gap before the run: outside
        const last = Math.min((starts[k] ?? 0) + (piece.cells[k * 2 + 1] ?? 0), to);
        const old = piece.cells[k * 2] ?? 0;
        emit(old === 0 ? 0 : (remap.get(old) ?? 0), last - first);
        cursor = last;
      }
    }
  }
  // Trailing cells outside the piece are implied.
  if (run > 0 && current !== 0) cells.push(current, run);

  const anchor = piece.anchor;
  return {
    size: [nx, ny, nz],
    north: piece.north,
    ...(anchor && {
      anchor: [
        Math.min(Math.max(anchor[0] - lo[0], 0), nx - 1),
        Math.min(Math.max(anchor[1] - lo[1], 0), ny - 1),
        Math.min(Math.max(anchor[2] - lo[2], 0), nz - 1),
      ],
    }),
    ...(piece.origin !== undefined && { origin: piece.origin }),
    semantics,
    states,
    cells,
  };
}

/** The box of the cells whose state number passes `keep`, read off the runs. */
function boundsOfRuns(
  piece: Piece,
  keep: (n: number) => boolean,
): { lo: [number, number, number]; hi: [number, number, number] } | null {
  const [w, , d] = piece.size;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let at = 0;
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    const n = piece.cells[r] ?? 0;
    const run = piece.cells[r + 1] ?? 0;
    const first = at;
    at += run;
    if (n === 0 || !keep(n)) continue;
    const last = at - 1;
    const row0 = Math.floor(first / w);
    const row1 = Math.floor(last / w);
    const y0 = Math.floor(row0 / d);
    const y1 = Math.floor(row1 / d);
    const z0 = row0 % d;
    const z1 = row1 % d;
    // A run inside one row spans only its own x; across rows it may cover the whole width.
    lo[0] = Math.min(lo[0], row0 === row1 ? first % w : 0);
    hi[0] = Math.max(hi[0], row0 === row1 ? last % w : w - 1);
    lo[1] = Math.min(lo[1], y0);
    hi[1] = Math.max(hi[1], y1);
    lo[2] = Math.min(lo[2], y0 === y1 ? z0 : 0);
    hi[2] = Math.max(hi[2], y0 === y1 ? z1 : d - 1);
  }
  return lo[0] === Infinity ? null : { lo, hi };
}
