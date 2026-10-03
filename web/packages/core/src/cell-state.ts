// What a cell holds: intent, never materials. `semantic` is a role name such as "Mass" or
// "Trim". Palettes map semantics to blocks in a separate layer, so swapping a palette never
// touches cell data (CLAUDE.md principles 1 and 3).
//
// Chunks store cells as Uint16 ids into a CellStateTable, which interns each distinct
// (semantic, orientation, tags, parts) combination once. A big build uses a few hundred
// distinct states at most, so cells stay two bytes each even when shaped.

/** One shaped part in a cell: a semantic placed as `shape` in `slot` (Godot's [semantic, shape, slot]). */
export interface Part {
  readonly semantic: string;
  readonly shape: string;
  readonly slot: number;
}

export type TagValue = string | number | boolean;

export interface CellState {
  /** For a shaped cell, its first part's semantic, as in the Godot app. */
  readonly semantic: string;
  readonly orientation: number;
  readonly tags: Readonly<Record<string, TagValue>>;
  /** Empty for a whole block. */
  readonly parts: readonly Part[];
}

export interface CellStateInput {
  readonly semantic?: string;
  readonly orientation?: number;
  readonly tags?: Readonly<Record<string, TagValue>>;
  readonly parts?: readonly Part[];
}

/** The id of an empty cell. Never stored in the table. */
export const EMPTY_ID = 0;

/** Ids are Uint16 and 0 means empty. */
export const MAX_STATES = 0xffff;

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
    if (p.semantic === "" || p.shape === "") {
      throw new TypeError("A part needs a semantic and a shape");
    }
    return Object.freeze({ semantic: p.semantic, shape: p.shape, slot: p.slot });
  });
  const semantic = input.semantic ?? parts[0]?.semantic ?? "";
  if (semantic === "") {
    throw new TypeError("A cell needs a semantic; use null to clear a cell");
  }
  const orientation = input.orientation ?? 0;
  if (!Number.isInteger(orientation)) {
    throw new TypeError(`Orientation must be an integer, got ${orientation}`);
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
    orientation,
    tags: Object.freeze(tags),
    parts: Object.freeze(parts),
  });
}

function canonicalKey(state: CellState): string {
  // Tags are already sorted by normalize(), so equal states always produce the same key.
  return JSON.stringify([
    state.semantic,
    state.orientation,
    Object.entries(state.tags),
    state.parts.map((p) => [p.semantic, p.shape, p.slot]),
  ]);
}
