// What a cell holds: intent, never materials (CLAUDE.md principles 1 and 3). A cell is either
// one whole block of a semantic, or a list of shaped parts, each with its own semantic. Both
// refer to semantics by id (see semantics.ts), so renaming a semantic or re-skinning a palette
// touches no cells.
//
// Chunks store cells as Uint16 ids into a CellStateTable, which interns each distinct
// (semantic, rotation, tags, parts) combination once. A big build uses a few hundred distinct
// states at most, so cells stay two bytes each even when shaped. The table is append-only, so
// ids keep their meaning in saved chunks and in commands already sent.

import { IDENTITY, isRotation, type Rotation } from "./rotation.ts";
import { NO_SEMANTIC, type SemanticId } from "./semantics.ts";

/** One shaped part in a cell: a semantic placed as `shape` in `slot`. */
export interface Part {
  readonly semantic: SemanticId;
  readonly shape: string;
  readonly slot: number;
}

export type TagValue = string | number | boolean;

export interface CellState {
  /** The whole block's semantic, or NO_SEMANTIC for a cell of parts. */
  readonly semantic: SemanticId;
  /** One of the 24 cube rotations (see rotation.ts). */
  readonly rotation: Rotation;
  readonly tags: Readonly<Record<string, TagValue>>;
  /** Empty for a whole block. */
  readonly parts: readonly Part[];
}

export interface CellStateInput {
  readonly semantic?: SemanticId;
  readonly rotation?: Rotation;
  readonly tags?: Readonly<Record<string, TagValue>>;
  readonly parts?: readonly Part[];
}

/** The id of an empty cell. Never stored in the table. */
export const EMPTY_ID = 0;

/** Ids are Uint16 and 0 means empty. */
export const MAX_STATES = 0xffff;

/** The semantics a state uses: its block's, or each part's (repeats included, in order). */
export function semanticsOf(state: CellState): SemanticId[] {
  return state.parts.length > 0 ? state.parts.map((p) => p.semantic) : [state.semantic];
}

export class CellStateTable {
  // Index 0 is a placeholder for EMPTY_ID, so a state's id is its index.
  readonly #states: (CellState | null)[] = [null];
  readonly #ids = new Map<string, number>();

  /** Number of distinct states, not counting empty. */
  get size(): number {
    return this.#states.length - 1;
  }

  /** The id for this state, adding it if it's new. */
  intern(input: CellStateInput): number {
    const state = normalize(input);
    const key = canonicalKey(state);
    const existing = this.#ids.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.#states.length;
    if (id > MAX_STATES) {
      throw new RangeError(`Too many distinct cell states (limit ${MAX_STATES})`);
    }
    this.#states.push(state);
    this.#ids.set(key, id);
    return id;
  }

  /** The state for an id, or null for EMPTY_ID. */
  get(id: number): CellState | null {
    const state = this.#states[id];
    if (state === undefined) {
      throw new RangeError(`Unknown cell state id ${id}`);
    }
    return state;
  }

  has(id: number): boolean {
    return Number.isInteger(id) && id >= 0 && id < this.#states.length;
  }
}

function normalize(input: CellStateInput): CellState {
  const parts = (input.parts ?? []).map((p) => {
    if (!isSemanticId(p.semantic) || p.shape === "") {
      throw new TypeError("A part needs a semantic id and a shape");
    }
    return Object.freeze({ semantic: p.semantic, shape: p.shape, slot: p.slot });
  });
  const semantic = input.semantic ?? NO_SEMANTIC;
  if (parts.length > 0 && semantic !== NO_SEMANTIC) {
    throw new TypeError("A cell is either a whole block or a list of parts, not both");
  }
  if (parts.length === 0 && !isSemanticId(semantic)) {
    throw new TypeError("A cell needs a semantic id or parts; use EMPTY_ID to clear a cell");
  }
  const rotation = input.rotation ?? IDENTITY;
  if (!isRotation(rotation)) {
    throw new TypeError(`Rotation must be an integer 0..23, got ${rotation}`);
  }
  const tags: Record<string, TagValue> = {};
  for (const name of Object.keys(input.tags ?? {}).sort()) {
    const value = input.tags?.[name];
    if (value !== undefined) {
      tags[name] = value;
    }
  }
  return Object.freeze({
    semantic,
    rotation,
    tags: Object.freeze(tags),
    parts: Object.freeze(parts),
  });
}

function isSemanticId(id: number): boolean {
  return Number.isInteger(id) && id > NO_SEMANTIC;
}

function canonicalKey(state: CellState): string {
  // Tags are already sorted by normalize(), so equal states always produce the same key.
  return JSON.stringify([
    state.semantic,
    state.rotation,
    Object.entries(state.tags),
    state.parts.map((p) => [p.semantic, p.shape, p.slot]),
  ]);
}
