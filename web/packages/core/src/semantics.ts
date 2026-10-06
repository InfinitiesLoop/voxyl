// The project's semantic registry (web-core.md, section 2). Cells refer to semantics by id
// through the cell-state table, never by name, so renaming or describing a semantic touches no
// cells. Palettes, inheritance and forms build on this in the next step.

/** A semantic's id. 0 is never used, so it can mean "no semantic". */
export type SemanticId = number;

export const NO_SEMANTIC: SemanticId = 0;

export interface Semantic {
  readonly id: SemanticId;
  readonly name: string;
  /** What the semantic means, for people and agents ("Trim: a band at each floor line"). */
  readonly description?: string;
}

export class SemanticRegistry {
  // Index = id; index 0 is the unused NO_SEMANTIC slot.
  readonly #entries: (Semantic | null)[] = [null];
  readonly #byName = new Map<string, SemanticId>();

  /** Number of semantics. */
  get size(): number {
    return this.#byName.size;
  }

  /** Adds a semantic and returns its id. Names are unique. */
  add(name: string, description?: string): SemanticId {
    const clean = checkName(name);
    if (this.#byName.has(clean)) throw new Error(`A semantic named "${clean}" already exists`);
    const id = this.#entries.length;
    this.#entries.push(freeze(id, clean, description));
    this.#byName.set(clean, id);
    return id;
  }

  /** The id of the semantic with this name, adding it if there is none. */
  ensure(name: string): SemanticId {
    return this.#byName.get(checkName(name)) ?? this.add(name);
  }

  has(id: SemanticId): boolean {
    return Number.isInteger(id) && id > 0 && this.#entries[id] != null;
  }

  get(id: SemanticId): Semantic {
    const entry = this.#entries[id];
    if (!entry) throw new RangeError(`Unknown semantic id ${id}`);
    return entry;
  }

  /** The semantic's name, or "" for NO_SEMANTIC and unknown ids. */
  nameOf(id: SemanticId): string {
    return this.#entries[id]?.name ?? "";
  }

  byName(name: string): Semantic | undefined {
    const id = this.#byName.get(name);
    return id === undefined ? undefined : this.get(id);
  }

  rename(id: SemanticId, name: string): void {
    const entry = this.get(id);
    const clean = checkName(name);
    if (clean === entry.name) return;
    if (this.#byName.has(clean)) throw new Error(`A semantic named "${clean}" already exists`);
    this.#byName.delete(entry.name);
    this.#byName.set(clean, id);
    this.#entries[id] = freeze(id, clean, entry.description);
  }

  describe(id: SemanticId, description: string | undefined): void {
    const entry = this.get(id);
    this.#entries[id] = freeze(id, entry.name, description);
  }

  /** Every semantic, by id. */
  *[Symbol.iterator](): IterableIterator<Semantic> {
    for (const entry of this.#entries) if (entry) yield entry;
  }

  /** An independent copy (for forks). */
  clone(): SemanticRegistry {
    const copy = new SemanticRegistry();
    copy.#entries.length = 0;
    copy.#entries.push(...this.#entries);
    for (const [name, id] of this.#byName) copy.#byName.set(name, id);
    return copy;
  }
}

function checkName(name: string): string {
  const clean = name.trim();
  if (clean === "") throw new TypeError("A semantic needs a name");
  return clean;
}

function freeze(id: SemanticId, name: string, description: string | undefined): Semantic {
  return Object.freeze(description ? { id, name, description } : { id, name });
}
