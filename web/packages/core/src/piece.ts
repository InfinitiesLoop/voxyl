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
