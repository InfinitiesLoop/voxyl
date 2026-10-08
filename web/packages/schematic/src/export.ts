// Exports a piece (cells lifted out of a project, see core's piece.ts: a selection, the whole
// build, or a saved prefab) to Schematica's .schematic. Port of the Godot app's
// SchematicaExporter.gd.
//
// This is the only place semantics become Minecraft blocks, and only at the moment of export:
// each semantic's look names a block, and `identify` says what that block is in the game. The
// piece's cells are never touched. What can't be written is reported, never guessed:
//   - undecided: the semantic has no block chosen yet;
//   - unmapped: the block has no confirmed Minecraft identity;
//   - unsupported: a part whose shape has no ForgeMultipart / ArchitectureCraft equivalent, or
//     no image once the build is turned.
// Those cells come out as air.
//
// North is north: a piece knows which of its directions is the real north, and the file is
// written turned so that direction ends up on -Z, the north of the world it is pasted into
// (blocks' facings and parts' slots turn with it).
//
// Local ids (Blocks + SchematicaMapping): every reader that matters resolves a block through
// the name table, so the numbers are arbitrary. They stay inside the Blocks byte (1-255) so the
// file normally needs no AddBlocks, which Schematica and WorldEdit read in opposite nibble
// orders. A block's own id (McIdentity.legacyId) is used when it fits and is free, so a reader
// that ignores the tables stays right for vanilla blocks; everything else counts down from 255,
// far from the low ids (1 stone, 3 dirt) a raw reader would otherwise paste. Only a file with
// more than 255 distinct blocks spills into AddBlocks.

import {
  applyMatrix,
  type Direction,
  forEachPieceCell,
  movedBox,
  type Piece,
  placementMatrix,
  transformRotation,
  turnsBetween,
} from "@voxyl/core";
import { isExclusive, transformSlot } from "@voxyl/shapes";
import type { Compress } from "./gzip.ts";
import { finalMeta, type IdentityResolver, type McIdentity } from "./identity.ts";
import type { Compound } from "./nbt.ts";
import {
  AC_SHAPE_ID,
  acTile,
  acWorldRegistry,
  FMP_WORLD_REGISTRY,
  fmpPartTag,
  fmpTile,
  sawWarning,
} from "./parts.ts";
import { encodeSchematic, MAX_DIMENSION } from "./schematica.ts";

/** The most cells (width x height x length) one schematic may span. */
export const MAX_EXPORT_VOLUME = 1 << 27;

const BYTE_MAX = 255;

export interface ExportOptions {
  /** What a block is in Minecraft. */
  readonly identify: IdentityResolver;
  /** Piece semantic numbers (1-based) to leave out. */
  readonly exclude?: ReadonlySet<number>;
  /** Shrink the box to the cells that are kept (default: the piece's whole box). */
  readonly trim?: boolean;
  /** Quarter turns clockwise to swing the build by. Default: the piece's north to the game's. */
  readonly turns?: number;
  /** Known numeric ids of the multipart and shape placeholder blocks, by registry name. */
  readonly placeholderIds?: Readonly<Record<string, number>>;
  /** Count and report only: no block arrays are built, so it is cheap to repeat. */
  readonly dryRun?: boolean;
}

export interface ExportReport {
  /** The size as written (width, height, length), after any turn. */
  readonly size: readonly [number, number, number];
  /** Cells put into the file (a part cell counts once). */
  readonly cellsWritten: number;
  /** Cells kept (not excluded), whether or not they could be written. */
  readonly cellsKept: number;
  /** Cells left out because their semantic was unticked. */
  readonly cellsExcluded: number;
  readonly distinctBlocks: number;
  /** Cells by the registry name written, placeholder blocks included. */
  readonly mapped: Readonly<Record<string, number>>;
  /** Semantic name -> cells or parts whose semantic has no block chosen yet. */
  readonly undecided: Readonly<Record<string, number>>;
  /** Semantic name -> cells or parts whose block has no confirmed Minecraft identity. */
  readonly unmapped: Readonly<Record<string, number>>;
  /** Shape id -> parts that have no equivalent in the mods, or no image once turned. */
  readonly unsupported: Readonly<Record<string, number>>;
  /** Semantic name -> microblock parts cut from a block the saw can't cut. */
  readonly sawWarnings: Readonly<Record<string, number>>;
  /** Semantic name -> cells written from an identity that is a best reading, not confirmed. */
  readonly assumed: Readonly<Record<string, number>>;
  readonly tileEntities: number;
  /** Part cells where nothing resolved to a real block. */
  readonly emptyPartCells: number;
  /** Clockwise degrees the build was turned by (0 when it already faced north). */
  readonly turnedDegrees: number;
  /** Which of the piece's directions was the real north. */
  readonly north: Direction;
  /** Set when nothing can be written (too big, or nothing kept). */
  readonly problem: string | null;
}

export interface ExportPlan {
  readonly report: ExportReport;
  /** Everything the file holds; null for a dry run or when there is a problem. */
  readonly data: {
    readonly size: readonly [number, number, number];
    readonly blocks: Uint8Array;
    readonly add: Uint8Array | null;
    readonly metas: Uint8Array;
    readonly mapping: Record<string, number>;
    readonly tileEntities: Compound[];
  } | null;
}

type Bucket = "undecided" | "unmapped" | "unsupported" | "sawWarnings" | "assumed";

/** A finished cell state: what it writes, and what it reports (per cell holding it). */
interface Template {
  readonly written: boolean;
  readonly localId: number;
  readonly meta: number;
  readonly fmp: readonly Compound[] | null;
  readonly ac: {
    readonly shape: string;
    readonly slot: number;
    readonly material: McIdentity;
  } | null;
  /** The registry counted as mapped. */
  readonly mapped: string | null;
  readonly notes: readonly (readonly [Bucket, string])[];
  readonly emptyPart: boolean;
}

type Resolved =
  | { readonly kind: "ok"; readonly identity: McIdentity; readonly glow: boolean }
  | { readonly kind: "undecided" }
  | { readonly kind: "unmapped" };

/** How many cells of each state (index = the state's 1-based number; 0 is unused). */
export function tallyStates(piece: Piece): number[] {
  const counts = new Array<number>(piece.states.length + 1).fill(0);
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    const n = piece.cells[r] ?? 0;
    if (n > 0) counts[n] = (counts[n] ?? 0) + (piece.cells[r + 1] ?? 0);
  }
  return counts;
}

/** A state with the unticked semantics taken out, or null when nothing of it remains. */
type Kept =
  | { readonly rotation: number; readonly semantic: number; readonly parts: null }
  | {
      readonly rotation: number;
      readonly semantic: 0;
      readonly parts: readonly (readonly [number, string, number])[];
    };

function keptState(piece: Piece, n: number, exclude: ReadonlySet<number>): Kept | null {
  const state = piece.states[n - 1];
  if (!state) return null; // air
  const [semantic, rotation, , parts] = state;
  if (parts && parts.length > 0) {
    const left = parts.filter((p) => !exclude.has(p[0]));
    return left.length > 0 ? { rotation, semantic: 0, parts: left } : null;
  }
  return exclude.has(semantic) ? null : { rotation, semantic, parts: null };
}

/** The box of the cells kept, from the piece's runs (cheap, no cell is visited). */
function keptBounds(
  piece: Piece,
  exclude: ReadonlySet<number>,
): { lo: [number, number, number]; hi: [number, number, number] } | null {
  const [w, , d] = piece.size;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const keepers = new Map<number, boolean>();
  let at = 0;
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    const n = piece.cells[r] ?? 0;
    const run = piece.cells[r + 1] ?? 0;
    const first = at;
    at += run;
    if (n === 0) continue;
    let keep = keepers.get(n);
    if (keep === undefined) {
      keep = keptState(piece, n, exclude) !== null;
      keepers.set(n, keep);
    }
    if (!keep) continue;
    const last = at - 1;
    const row0 = Math.floor(first / w);
    const row1 = Math.floor(last / w);
    const y0 = Math.floor(row0 / d);
    const y1 = Math.floor(row1 / d);
    const z0 = row0 % d;
    const z1 = row1 % d;
    const x0 = row0 === row1 ? first % w : 0;
    const x1 = row0 === row1 ? last % w : w - 1;
    const zLo = y0 === y1 ? z0 : 0;
    const zHi = y0 === y1 ? z1 : d - 1;
    lo[0] = Math.min(lo[0], x0);
    lo[1] = Math.min(lo[1], y0);
    lo[2] = Math.min(lo[2], zLo);
    hi[0] = Math.max(hi[0], x1);
    hi[1] = Math.max(hi[1], y1);
    hi[2] = Math.max(hi[2], zHi);
  }
  return lo[0] === Infinity ? null : { lo, hi };
}

class Resolver {
  readonly #piece: Piece;
  readonly #identify: IdentityResolver;
  readonly #byBlock = new Map<string, McIdentity | null>();

  constructor(piece: Piece, identify: IdentityResolver) {
    this.#piece = piece;
    this.#identify = identify;
  }

  name(semantic: number): string {
    return this.#piece.semantics[semantic - 1]?.name ?? `#${semantic}`;
  }

  resolve(semantic: number): Resolved {
    const look = this.#piece.semantics[semantic - 1]?.look;
    const block = look?.block;
    if (block === undefined || block === "") return { kind: "undecided" };
    let identity = this.#byBlock.get(block);
    if (identity === undefined) {
      identity = this.#identify(block);
      this.#byBlock.set(block, identity);
    }
    return identity ? { kind: "ok", identity, glow: look?.glow === true } : { kind: "unmapped" };
  }
}

/**
 * Works out what the file would hold and what it would leave out. With `dryRun` that is only
 * the report; otherwise the arrays too, ready for encodeSchematic.
 */
export function planExport(piece: Piece, options: ExportOptions): ExportPlan {
  const exclude = options.exclude ?? new Set<number>();
  const counts = tallyStates(piece);
  const north = piece.north;
  const turns = (((options.turns ?? turnsBetween(north, "north")) % 4) + 4) % 4;
  const m = placementMatrix(turns);
  const empty = (problem: string, cellsExcluded = 0): ExportPlan => ({
    report: {
      size: [0, 0, 0],
      cellsWritten: 0,
      cellsKept: 0,
      cellsExcluded,
      distinctBlocks: 0,
      mapped: {},
      undecided: {},
      unmapped: {},
      unsupported: {},
      sawWarnings: {},
      assumed: {},
      tileEntities: 0,
      emptyPartCells: 0,
      turnedDegrees: turns * 90,
      north,
      problem,
    },
    data: null,
  });

  // The box of what is kept, and where it lands once turned.
  let cellsKept = 0;
  let cellsExcluded = 0;
  for (let n = 1; n < counts.length; n++) {
    const c = counts[n] ?? 0;
    if (c === 0) continue;
    if (keptState(piece, n, exclude)) cellsKept += c;
    else if (piece.states[n - 1]) cellsExcluded += c;
  }
  if (cellsKept === 0) return empty("Nothing is left to export.", cellsExcluded);
  const bounds = options.trim
    ? keptBounds(piece, exclude)
    : {
        lo: [0, 0, 0] as [number, number, number],
        hi: piece.size.map((s) => s - 1) as [number, number, number],
      };
  if (!bounds) return empty("Nothing is left to export.", cellsExcluded);
  const { lo, hi } = bounds;
  const moved = movedBox(
    { x0: 0, y0: 0, z0: 0, x1: hi[0] - lo[0], y1: hi[1] - lo[1], z1: hi[2] - lo[2] },
    m,
  );
  const size: [number, number, number] = [
    moved.x1 - moved.x0 + 1,
    moved.y1 - moved.y0 + 1,
    moved.z1 - moved.z0 + 1,
  ];
  const volume = size[0] * size[1] * size[2];
  if (size.some((s) => s > MAX_DIMENSION)) {
    return empty(`A schematic is at most ${MAX_DIMENSION} cells along each axis.`, cellsExcluded);
  }
  if (volume > MAX_EXPORT_VOLUME) {
    return empty(
      `That box is ${volume.toLocaleString("en-US")} cells; a schematic is at most ${MAX_EXPORT_VOLUME.toLocaleString("en-US")}. Select less, or trim the box.`,
      cellsExcluded,
    );
  }

  const resolver = new Resolver(piece, options.identify);
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  const alloc = (registry: string, legacyId: number | undefined): number => {
    const known = mapping[registry];
    if (known !== undefined) return known;
    let id: number;
    if (legacyId !== undefined && legacyId >= 1 && legacyId <= BYTE_MAX && !used.has(legacyId)) {
      id = legacyId;
    } else {
      id = BYTE_MAX;
      while (id >= 1 && used.has(id)) id--;
      if (id < 1) {
        // All 255 byte-sized ids are taken: the only case that needs AddBlocks.
        id = BYTE_MAX + 1;
        while (used.has(id)) id++;
      }
    }
    mapping[registry] = id;
    used.add(id);
    return id;
  };
  const placeholder = (registry: string): number =>
    alloc(registry, options.placeholderIds?.[registry]);

  // Cell states, each worked out once and reused for every cell that holds it.
  const templates: (Template | null | undefined)[] = [];
  const templateOf = (n: number): Template | null => {
    let t = templates[n];
    if (t === undefined) {
      const kept = keptState(piece, n, exclude);
      t = kept ? buildTemplate(kept) : null;
      templates[n] = t;
    }
    return t;
  };
  const buildTemplate = (kept: Kept): Template => {
    const notes: [Bucket, string][] = [];
    if (kept.parts === null) {
      const name = resolver.name(kept.semantic);
      const found = resolver.resolve(kept.semantic);
      if (found.kind !== "ok") {
        notes.push([found.kind, name]);
        return blank(notes);
      }
      const { identity } = found;
      if (identity.assumed) notes.push(["assumed", name]);
      const rotation = transformRotation(kept.rotation, m);
      return {
        written: true,
        localId: alloc(identity.registry, identity.legacyId),
        meta: finalMeta(identity, rotation) & 0xff,
        fmp: null,
        ac: null,
        mapped: identity.registry,
        notes,
        emptyPart: false,
      };
    }

    // Parts. One architecture shape keeps its cell to itself; the rest are microblocks.
    const only = kept.parts.length === 1 ? kept.parts[0] : undefined;
    if (only && isExclusive(only[1])) {
      const [semantic, shape, slot] = only;
      const name = resolver.name(semantic);
      const found = resolver.resolve(semantic);
      if (found.kind !== "ok") {
        notes.push([found.kind, name]);
        return blank(notes, true);
      }
      const turned = transformSlot(shape, slot, m);
      if (turned === null || !(shape in AC_SHAPE_ID)) {
        notes.push(["unsupported", shape]);
        return blank(notes, true);
      }
      if (found.identity.assumed) notes.push(["assumed", name]);
      const registry = acWorldRegistry(found.glow);
      return {
        written: true,
        localId: placeholder(registry),
        meta: 0,
        fmp: null,
        ac: { shape, slot: turned, material: found.identity },
        mapped: registry,
        notes,
        emptyPart: false,
      };
    }
    const tags: Compound[] = [];
    for (const [semantic, shape, slot] of kept.parts) {
      const name = resolver.name(semantic);
      const found = resolver.resolve(semantic);
      if (found.kind !== "ok") {
        notes.push([found.kind, name]);
        continue;
      }
      const turned = transformSlot(shape, slot, m);
      const tag = turned === null ? null : fmpPartTag(shape, turned, found.identity);
      if (!tag) {
        notes.push(["unsupported", shape]);
        continue;
      }
      tags.push(tag);
      if (sawWarning(found.identity, shape)) notes.push(["sawWarnings", name]);
      if (found.identity.assumed) notes.push(["assumed", name]);
    }
    if (tags.length === 0) return blank(notes, true);
    return {
      written: true,
      localId: placeholder(FMP_WORLD_REGISTRY),
      meta: 0,
      fmp: tags,
      ac: null,
      mapped: FMP_WORLD_REGISTRY,
      notes,
      emptyPart: false,
    };
  };

  // Writing the cells.
  const arrays = options.dryRun
    ? null
    : { blocks: new Uint8Array(volume), metas: new Uint8Array(volume) };
  let add: Uint8Array | null = null;
  const tileEntities: Compound[] = [];
  if (arrays) {
    const [width, , length] = size;
    forEachPieceCell(piece, (x, y, z, n) => {
      const t = templateOf(n);
      if (!t?.written) return;
      const [ax, ay, az] = applyMatrix(m, [x - lo[0], y - lo[1], z - lo[2]]);
      const px = ax - moved.x0;
      const py = ay - moved.y0;
      const pz = az - moved.z0;
      const index = (py * length + pz) * width + px;
      arrays.blocks[index] = t.localId & 0xff;
      if (t.localId > BYTE_MAX) {
        add ??= new Uint8Array((volume + 1) >> 1);
        const nibble = (t.localId >> 8) & 0xf;
        const at = index >> 1;
        add[at] =
          index % 2 === 0
            ? ((add[at] ?? 0) & 0x0f) | (nibble << 4)
            : ((add[at] ?? 0) & 0xf0) | nibble;
      }
      arrays.metas[index] = t.meta;
      if (t.fmp) tileEntities.push(fmpTile(px, py, pz, t.fmp));
      else if (t.ac) {
        const tag = acTile(px, py, pz, t.ac.shape, t.ac.slot, t.ac.material);
        if (tag) tileEntities.push(tag);
      }
    });
  } else {
    // A dry run still names the blocks it would write.
    for (let n = 1; n < counts.length; n++) if ((counts[n] ?? 0) > 0) templateOf(n);
  }

  // The report: every state's notes times how many cells hold it.
  const mapped: Record<string, number> = {};
  const buckets: Record<Bucket, Record<string, number>> = {
    undecided: {},
    unmapped: {},
    unsupported: {},
    sawWarnings: {},
    assumed: {},
  };
  let cellsWritten = 0;
  let emptyPartCells = 0;
  let tileCount = 0;
  for (let n = 1; n < counts.length; n++) {
    const c = counts[n] ?? 0;
    const t = c > 0 ? templateOf(n) : null;
    if (!t) continue;
    for (const [bucket, key] of t.notes) buckets[bucket][key] = (buckets[bucket][key] ?? 0) + c;
    if (t.emptyPart) emptyPartCells += c;
    if (!t.written) continue;
    cellsWritten += c;
    if (t.mapped) mapped[t.mapped] = (mapped[t.mapped] ?? 0) + c;
    if (t.fmp || t.ac) tileCount += c;
  }

  const report: ExportReport = {
    size,
    cellsWritten,
    cellsKept,
    cellsExcluded,
    distinctBlocks: Object.keys(mapping).length,
    mapped,
    ...buckets,
    tileEntities: tileCount,
    emptyPartCells,
    turnedDegrees: turns * 90,
    north,
    problem: null,
  };
  return {
    report,
    data: arrays ? { size, ...arrays, add, mapping, tileEntities } : null,
  };
}

function blank(notes: readonly (readonly [Bucket, string])[], emptyPart = false): Template {
  return {
    written: false,
    localId: 0,
    meta: 0,
    fmp: null,
    ac: null,
    mapped: null,
    notes,
    emptyPart,
  };
}

/** Plans the export and writes the gzipped file. Throws when there is a problem. */
export async function exportSchematic(
  piece: Piece,
  options: Omit<ExportOptions, "dryRun">,
  compress?: Compress,
): Promise<{ bytes: Uint8Array; report: ExportReport }> {
  const plan = planExport(piece, options);
  if (!plan.data) throw new Error(plan.report.problem ?? "Nothing to export");
  return { bytes: await encodeSchematic(plan.data, compress), report: plan.report };
}
