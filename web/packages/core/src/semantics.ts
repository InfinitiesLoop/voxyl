// The project's semantics and palettes (web-core.md, section 2).
//
// Cells refer to semantics by id (through the cell-state table), never by name or palette, so
// renaming, describing or re-skinning touches no cells. Every semantic lives in one palette,
// which is its group: "the walkway" is the cells whose semantics live in the Walkway palette.
// A palette can extend another; a semantic derived from a parent palette's semantic (its
// `base`) inherits the base's name, description, form and look until it overrides them, so
// re-skinning a parent re-skins every child that hasn't overridden the look.
//
// Intent sits on the semantic (form: shape, placement), material on its look (block, glow,
// tint). Each semantic belongs to exactly one palette, so its look is that palette's look for it.

import type { PlacementProfile } from "./placement-profile.ts";

/** A semantic's id. 0 is never used, so it can mean "no semantic". */
export type SemanticId = number;
export type PaletteId = number;

export const NO_SEMANTIC: SemanticId = 0;
/** Every project starts with this palette; a simple build never needs another. */
export const ROOT_PALETTE: PaletteId = 1;
const NO_PALETTE: PaletteId = 0;

/** Intent: what a semantic is and how it is placed. */
export interface Form {
  /** A part shape ("edge1", "roof_tile") the semantic places by default, or none for blocks. */
  readonly shape?: string;
  /** How a whole block of it may be oriented (see placement-profile.ts). Default: freely. */
  readonly placement?: PlacementProfile;
}

/** Material: what a semantic looks like. Never stored in cells. */
export interface Look {
  /** A qualified block reference, "library:block". None = undecided. */
  readonly block?: string;
  readonly glow?: boolean;
  /** A hint colour, "#rrggbb": how an undecided semantic draws, or a tint. */
  readonly tint?: string;
}

export interface Palette {
  readonly id: PaletteId;
  readonly name: string;
  readonly description?: string;
  readonly extends?: PaletteId;
  /** A linked copy of a shared (user-level) palette, re-synced by a command. */
  readonly linked?: { readonly key: string; readonly version: number };
}

/** A semantic as stored: only what it sets itself. */
export interface Semantic {
  readonly id: SemanticId;
  readonly palette: PaletteId;
  /** Required unless derived; a derived semantic without one shows its base's name. */
  readonly name?: string;
  readonly description?: string;
  /** The parent palette's semantic this one derives from. */
  readonly base?: SemanticId;
  readonly form?: Form;
  readonly look?: Look;
  /** For semantics of a linked palette: the shared semantic's key, to match on re-sync. */
  readonly sharedKey?: string;
}

/** A semantic with inheritance applied. */
export interface ResolvedSemantic {
  readonly id: SemanticId;
  readonly palette: PaletteId;
  readonly name: string;
  readonly description?: string;
  readonly base?: SemanticId;
  readonly form: Form;
  readonly look: Look;
}

export interface SemanticPatch {
  /** null on a derived semantic goes back to the base's name. */
  readonly name?: string | null;
  readonly description?: string | null;
  readonly form?: Form | null;
  readonly look?: Look | null;
}

export interface PalettePatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly extends?: PaletteId | null;
}

/**
 * A shared (user-level) palette as it travels into a project. The project keeps a linked copy,
 * so it stays self-contained (it renders for anyone, and on the server), and palette_sync
 * re-syncs the copy when the shared palette changes. Semantics match by key across syncs.
 */
export interface SharedPalette {
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly description?: string;
  readonly semantics: readonly {
    readonly key: string;
    readonly name: string;
    readonly description?: string;
    readonly form?: Form;
    readonly look?: Look;
  }[];
}

/** A semantic a palette can place: one of its own, or one it can derive from an ancestor. */
export interface Offer {
  readonly name: string;
  /** Set when the semantic exists in this palette. */
  readonly id?: SemanticId;
  /** Set when it would be derived on first use (from this ancestor semantic). */
  readonly base?: SemanticId;
}

/** The registry as saved: entries exactly as stored, by id. */
export interface RegistryJSON {
  readonly palettes: readonly Palette[];
  readonly semantics: readonly Semantic[];
}

export class SemanticRegistry {
  // Index = id; index 0 is unused for both.
  #semantics: (Semantic | null)[] = [null];
  #palettes: (Palette | null)[] = [null];
  #revision = 0;
  // Set while palette_sync writes into a linked palette, which is otherwise read-only.
  #syncing = false;

  constructor() {
    this.#palettes.push(Object.freeze({ id: ROOT_PALETTE, name: "Main" }));
  }

  /** Bumped by every change, so callers can tell whether anything changed. */
  get revision(): number {
    return this.#revision;
  }

  /** Number of semantics. */
  get size(): number {
    return this.#semantics.length - 1;
  }

  // --- Palettes ---

  addPalette(name: string, options: { description?: string; extends?: PaletteId } = {}): PaletteId {
    const id = this.#palettes.length;
    if (options.extends !== undefined) this.palette(options.extends);
    this.#checkPaletteName(name, id);
    this.#palettes.push(freezePalette({ id, name: clean(name), ...options }));
    this.#revision++;
    return id;
  }

  /**
   * Removes a palette and its semantics from the registry (the project stops having them; a
   * shared palette a linked copy came from is untouched). Refused for the root palette and for
   * one that other palettes extend. The caller checks that no cell uses its semantics
   * (palette_remove does). Ids are not reused while the registry is open.
   */
  removePalette(id: PaletteId): void {
    const p = this.palette(id);
    if (id === ROOT_PALETTE) throw new Error(`${p.name} is the project's main palette`);
    const children = this.palettes().filter((other) => other.extends === id);
    const first = children[0];
    if (first) {
      throw new Error(
        `${first.name} extends ${p.name}: change what it extends, or remove it first`,
      );
    }
    for (const s of this.semanticsIn(id)) this.#semantics[s] = null;
    this.#palettes[id] = null;
    this.#revision++;
  }

  hasPalette(id: PaletteId): boolean {
    return Number.isInteger(id) && id > 0 && this.#palettes[id] != null;
  }

  palette(id: PaletteId): Palette {
    const p = this.#palettes[id];
    if (!p) throw new RangeError(`Unknown palette id ${id}`);
    return p;
  }

  paletteByName(name: string): Palette | undefined {
    return this.palettes().find((p) => p.name === name);
  }

  palettes(): Palette[] {
    return this.#palettes.filter((p): p is Palette => p !== null);
  }

  updatePalette(id: PaletteId, patch: PalettePatch): void {
    this.#checkWritable(id);
    const p = this.palette(id);
    const next: Record<string, unknown> = { ...p };
    if (patch.name !== undefined) {
      this.#checkPaletteName(patch.name, id);
      next.name = clean(patch.name);
    }
    if (patch.description !== undefined) next.description = patch.description ?? undefined;
    if (patch.extends !== undefined) {
      if (patch.extends !== null) {
        this.palette(patch.extends);
        if (patch.extends === id || this.ancestorsOf(patch.extends).includes(id)) {
          throw new Error(`Palette ${p.name} can't extend its own descendant`);
        }
      }
      next.extends = patch.extends ?? undefined;
      const ancestors = new Set(
        patch.extends === null ? [] : [patch.extends, ...this.ancestorsOf(patch.extends)],
      );
      for (const s of this.semanticsIn(id)) {
        const base = this.get(s).base;
        if (base !== undefined && !ancestors.has(this.get(base).palette)) {
          throw new Error(
            `${this.nameOf(s)} derives from a palette ${p.name} would no longer extend`,
          );
        }
      }
    }
    this.#palettes[id] = freezePalette(next as unknown as Palette);
    this.#revision++;
  }

  /** The palettes a palette extends, nearest first. */
  ancestorsOf(id: PaletteId): PaletteId[] {
    const out: PaletteId[] = [];
    let p = this.palette(id).extends;
    while (p !== undefined) {
      out.push(p);
      p = this.palette(p).extends;
    }
    return out;
  }

  /** The palettes that extend this one, directly or not. */
  descendantsOf(id: PaletteId): PaletteId[] {
    return this.palettes()
      .filter((p) => this.ancestorsOf(p.id).includes(id))
      .map((p) => p.id);
  }

  /**
   * Creates or re-syncs the linked copy of a shared palette and returns its id. Semantics are
   * matched by key, so their ids (and the cells using them) stay put. A semantic dropped from
   * the shared palette stays in the copy, since cells may still use it. An older version than
   * the copy's is ignored.
   */
  sync(shared: SharedPalette): PaletteId {
    let id = this.palettes().find((p) => p.linked?.key === shared.key)?.id;
    if (id !== undefined && (this.palette(id).linked?.version ?? 0) > shared.version) return id;
    this.#syncing = true;
    try {
      const fields = {
        ...(shared.description !== undefined && { description: shared.description }),
        linked: { key: shared.key, version: shared.version },
      };
      if (id === undefined) {
        this.#checkPaletteName(shared.name, NO_PALETTE);
        id = this.#palettes.length;
        this.#palettes.push(freezePalette({ id, name: clean(shared.name), ...fields }));
      } else {
        this.#checkPaletteName(shared.name, id);
        this.#palettes[id] = freezePalette({ id, name: clean(shared.name), ...fields });
      }
      for (const entry of shared.semantics) {
        const patch = {
          name: entry.name,
          description: entry.description ?? null,
          form: entry.form ?? null,
          look: entry.look ?? null,
        };
        const existing = this.semanticsIn(id).find((s) => this.get(s).sharedKey === entry.key);
        if (existing !== undefined) this.update(existing, patch);
        else {
          const added = this.add(entry.name, { palette: id });
          const s = this.get(added);
          this.#semantics[added] = freezeSemantic({ ...s, sharedKey: entry.key });
          this.update(added, patch);
        }
      }
      this.#revision++;
      return id;
    } finally {
      this.#syncing = false;
    }
  }

  /**
   * Makes an ordinary palette the linked copy of the shared palette `linked.key`, with each of
   * its own semantics (`keys`, by id) matched to the shared one of that key. Ids, and so cells,
   * stay put. Refused for a palette that extends another, or has a semantic derived from
   * another palette's: a linked copy has no parents.
   */
  link(
    id: PaletteId,
    linked: { readonly key: string; readonly version: number },
    keys: ReadonlyMap<SemanticId, string>,
  ): void {
    const p = this.palette(id);
    if (p.linked) throw new Error(`${p.name} is already a linked copy`);
    if (p.extends !== undefined) {
      throw new Error(`${p.name} extends ${this.palette(p.extends).name}; a shared palette can't`);
    }
    if (this.palettes().some((other) => other.linked?.key === linked.key)) {
      throw new Error("A palette is already linked to that shared palette");
    }
    const own = this.semanticsIn(id);
    for (const s of own) {
      if (this.get(s).base !== undefined) {
        throw new Error(`${this.nameOf(s)} is derived from another palette's semantic`);
      }
      if (!keys.get(s)) throw new Error(`${this.nameOf(s)} has no key in the shared palette`);
    }
    const seen = new Set<string>();
    for (const s of own) {
      const key = keys.get(s) as string;
      if (seen.has(key)) throw new Error(`Two semantics share the key ${key}`);
      seen.add(key);
    }
    for (const s of own) {
      this.#semantics[s] = freezeSemantic({ ...this.get(s), sharedKey: keys.get(s) as string });
    }
    this.#palettes[id] = freezePalette({
      ...p,
      linked: { key: linked.key, version: linked.version },
    });
    this.#revision++;
  }

  /** Makes a linked copy an ordinary palette again. Its semantics keep their ids and looks. */
  unlink(id: PaletteId): void {
    const p = this.palette(id);
    if (!p.linked) throw new Error(`${p.name} isn't a linked copy`);
    const { linked: _, ...rest } = p;
    this.#palettes[id] = freezePalette(rest as Palette);
    for (const s of this.semanticsIn(id)) {
      const { sharedKey: __, ...entry } = this.get(s);
      this.#semantics[s] = freezeSemantic(entry as Semantic);
    }
    this.#revision++;
  }

  #checkWritable(palette: PaletteId): void {
    const p = this.palette(palette);
    if (p.linked && !this.#syncing) {
      throw new Error(
        `${p.name} is a linked copy of a shared palette; edit the shared one, or derive`,
      );
    }
  }

  // --- Semantics ---

  /** Adds a semantic to a palette (the root palette by default) and returns its id. */
  add(
    name: string,
    options: { palette?: PaletteId; description?: string; form?: Form; look?: Look } = {},
  ): SemanticId {
    const palette = options.palette ?? ROOT_PALETTE;
    this.#checkWritable(palette);
    this.#checkName(palette, name, NO_SEMANTIC);
    const id = this.#semantics.length;
    const { palette: _, ...rest } = options;
    this.#semantics.push(freezeSemantic({ id, palette, name: clean(name), ...rest }));
    this.#revision++;
    return id;
  }

  /**
   * The semantic in `palette` derived from `base` (a semantic of one of its ancestors),
   * created on first use. Deriving from a semantic of the palette itself returns it.
   */
  derive(palette: PaletteId, base: SemanticId): SemanticId {
    const b = this.get(base);
    if (b.palette === palette) return base;
    this.#checkWritable(palette);
    if (!this.ancestorsOf(palette).includes(b.palette)) {
      throw new Error(
        `${this.palette(palette).name} doesn't extend the palette ${this.nameOf(base)} is in`,
      );
    }
    for (const s of this.semanticsIn(palette)) if (this.get(s).base === base) return s;
    // An ancestor's semantic further down the chain derives through the nearer palettes'
    // derived semantic when there is one, so overrides along the way are kept.
    const nearer = this.ancestorsOf(palette).find((p) =>
      this.semanticsIn(p).some((s) => this.get(s).base === base),
    );
    const via = nearer === undefined ? base : this.derive(nearer, base);
    this.#checkName(palette, this.nameOf(via), NO_SEMANTIC);
    const id = this.#semantics.length;
    this.#semantics.push(freezeSemantic({ id, palette, base: via }));
    this.#revision++;
    return id;
  }

  /**
   * Removes a semantic. It must be in a writable palette and nothing may derive from it; the
   * caller checks that no cell uses it (semantic_remove does). Its id is not reused while
   * the registry is open.
   */
  remove(id: SemanticId): void {
    const s = this.get(id);
    this.#checkWritable(s.palette);
    for (const other of this.#ids()) {
      if (this.get(other).base !== id) continue;
      const where = this.palette(this.get(other).palette).name;
      throw new Error(`${this.nameOf(other)} in ${where} derives from ${this.nameOf(id)}`);
    }
    this.#semantics[id] = null;
    this.#revision++;
  }

  /** The id of a root-palette semantic with this name, adding it if there is none. */
  ensure(name: string, palette: PaletteId = ROOT_PALETTE): SemanticId {
    return this.byName(name, palette) ?? this.add(name, { palette });
  }

  has(id: SemanticId): boolean {
    return Number.isInteger(id) && id > 0 && this.#semantics[id] != null;
  }

  /** The semantic as stored (only what it sets itself). */
  get(id: SemanticId): Semantic {
    const s = this.#semantics[id];
    if (!s) throw new RangeError(`Unknown semantic id ${id}`);
    return s;
  }

  /** The semantic with inheritance applied. */
  resolve(id: SemanticId): ResolvedSemantic {
    const s = this.get(id);
    const base = s.base === undefined ? undefined : this.resolve(s.base);
    const description = s.description ?? base?.description;
    return Object.freeze({
      id,
      palette: s.palette,
      name: s.name ?? base?.name ?? "",
      ...(description !== undefined && { description }),
      ...(s.base !== undefined && { base: s.base }),
      form: Object.freeze({ ...base?.form, ...s.form }),
      look: Object.freeze({ ...base?.look, ...s.look }),
    });
  }

  /** The resolved name, or "" for NO_SEMANTIC and unknown ids. */
  nameOf(id: SemanticId): string {
    return this.has(id) ? this.resolve(id).name : "";
  }

  /** The semantic named `name` in a palette, or in any palette (lowest id first) if none given. */
  byName(name: string, palette?: PaletteId): SemanticId | undefined {
    const wanted = name.trim();
    const pool = palette === undefined ? this.#ids() : this.semanticsIn(palette);
    // Own names win over inherited ones.
    return (
      pool.find((s) => this.get(s).name === wanted) ?? pool.find((s) => this.nameOf(s) === wanted)
    );
  }

  /** The semantics living in a palette (its group), optionally with its descendants'. */
  semanticsIn(palette: PaletteId, withDescendants = false): SemanticId[] {
    const palettes = new Set([palette, ...(withDescendants ? this.descendantsOf(palette) : [])]);
    return this.#ids().filter((s) => palettes.has(this.get(s).palette));
  }

  /** What a palette can place: its own semantics, then ancestors' ones it can derive. */
  offers(palette: PaletteId): Offer[] {
    const own = this.semanticsIn(palette);
    const out: Offer[] = own.map((id) => ({ name: this.nameOf(id), id }));
    const covered = new Set(own.map((s) => this.get(s).base).filter((b) => b !== undefined));
    const names = new Set(out.map((o) => o.name));
    for (const ancestor of this.ancestorsOf(palette)) {
      for (const s of this.semanticsIn(ancestor)) {
        if (covered.has(s)) continue;
        const name = this.nameOf(s);
        if (names.has(name)) continue;
        out.push({ name, base: s });
        names.add(name);
        // Its own base, further up, is covered by it.
        const b = this.get(s).base;
        if (b !== undefined) covered.add(b);
      }
    }
    return out;
  }

  update(id: SemanticId, patch: SemanticPatch): void {
    const s = this.get(id);
    this.#checkWritable(s.palette);
    const next: Record<string, unknown> = { ...s };
    if (patch.name !== undefined) {
      if (patch.name === null) {
        if (s.base === undefined) throw new Error("Only a derived semantic can drop its name");
        next.name = undefined;
      } else {
        this.#checkName(s.palette, patch.name, id);
        next.name = clean(patch.name);
      }
    }
    if (patch.description !== undefined) next.description = patch.description ?? undefined;
    if (patch.form !== undefined) next.form = patch.form ?? undefined;
    if (patch.look !== undefined) next.look = patch.look ?? undefined;
    this.#semantics[id] = freezeSemantic(next as unknown as Semantic);
    this.#revision++;
  }

  rename(id: SemanticId, name: string): void {
    this.update(id, { name });
  }

  describe(id: SemanticId, description: string | undefined): void {
    this.update(id, { description: description ?? null });
  }

  /** Every semantic as stored, by id. */
  *[Symbol.iterator](): IterableIterator<Semantic> {
    for (const s of this.#semantics) if (s) yield s;
  }

  toJSON(): RegistryJSON {
    return { palettes: this.palettes(), semantics: [...this] };
  }

  /** A registry from its saved form. Ids are kept, so cells and commands keep meaning. */
  static fromJSON(json: RegistryJSON): SemanticRegistry {
    const r = new SemanticRegistry();
    r.#palettes = [null];
    r.#semantics = [null];
    for (const p of json.palettes) {
      if (!Number.isInteger(p.id) || p.id < 1 || r.#palettes[p.id])
        throw new Error(`Bad palette id ${p.id}`);
      r.#palettes[p.id] = freezePalette({ ...p });
    }
    for (const s of json.semantics) {
      if (!Number.isInteger(s.id) || s.id < 1 || r.#semantics[s.id])
        throw new Error(`Bad semantic id ${s.id}`);
      if (!r.#palettes[s.palette]) throw new Error(`Semantic ${s.id} is in an unknown palette`);
      r.#semantics[s.id] = freezeSemantic({ ...s });
    }
    for (let i = 0; i < r.#palettes.length; i++) r.#palettes[i] ??= null;
    for (let i = 0; i < r.#semantics.length; i++) r.#semantics[i] ??= null;
    if (!r.#palettes[ROOT_PALETTE]) throw new Error("A saved registry needs the root palette");
    return r;
  }

  /** An independent copy (for forks and undo snapshots). Entries are frozen, so this is shallow. */
  clone(): SemanticRegistry {
    const copy = new SemanticRegistry();
    copy.#semantics = [...this.#semantics];
    copy.#palettes = [...this.#palettes];
    copy.#revision = this.#revision;
    return copy;
  }

  /**
   * Makes this registry's contents a copy of another's (to undo a change). The revision still
   * moves forward, so anything caching by revision sees a change.
   */
  restore(from: SemanticRegistry): void {
    this.#semantics = [...from.#semantics];
    this.#palettes = [...from.#palettes];
    this.#revision = Math.max(this.#revision, from.#revision) + 1;
  }

  #ids(): SemanticId[] {
    const ids: SemanticId[] = [];
    for (let id = 1; id < this.#semantics.length; id++) if (this.#semantics[id]) ids.push(id);
    return ids;
  }

  #checkName(palette: PaletteId, name: string, self: SemanticId): void {
    const wanted = clean(name);
    for (const s of this.semanticsIn(palette)) {
      if (s !== self && this.nameOf(s) === wanted) {
        throw new Error(`${this.palette(palette).name} already has a semantic named "${wanted}"`);
      }
    }
  }

  #checkPaletteName(name: string, self: PaletteId): void {
    const wanted = clean(name);
    if (this.palettes().some((p) => p.id !== self && p.name === wanted)) {
      throw new Error(`A palette named "${wanted}" already exists`);
    }
  }
}

function clean(name: string): string {
  const c = name.trim();
  if (c === "") throw new TypeError("A name can't be empty");
  return c;
}

/** Freezes an entry, dropping undefined fields so stored entries stay minimal. */
function freezeSemantic(s: Semantic): Semantic {
  return Object.freeze(stripUndefined(s)) as Semantic;
}

function freezePalette(p: Palette): Palette {
  return Object.freeze(stripUndefined(p)) as Palette;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
