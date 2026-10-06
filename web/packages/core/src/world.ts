import { type CellState, type CellStateInput, CellStateTable, EMPTY_ID } from "./cell-state.ts";
import { Chunk } from "./chunk.ts";
import { ChunkLayout, chunkKey, chunkKeyToCoords } from "./coords.ts";

/** A box of cells, corners inclusive, with x0 <= x1, y0 <= y1, z0 <= z1. */
export interface ChangedBox {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
}

export interface WorldOptions {
  /** Chunk edge length as a power of two (5 = 32 cells). */
  readonly chunkBits?: number;
  /** A state table to share (forks share their parent's; it is append-only). */
  readonly states?: CellStateTable;
}

/**
 * The chunks one edit touched, before and after it, keyed by chunk key (null = no chunk).
 * Snapshots are copy-on-write clones, so an edit costs only the bricks it wrote. Restoring
 * `before` undoes the edit and restoring `after` redoes it.
 */
export interface Edit {
  readonly before: ReadonlyMap<number, Chunk | null>;
  readonly after: ReadonlyMap<number, Chunk | null>;
}

/**
 * The single source of truth for a project's cells (the web counterpart of VoxelData).
 * Views, meshers and tools all read and write through it; none of them owns cell data.
 */
export class World {
  readonly layout: ChunkLayout;
  readonly states: CellStateTable;
  readonly #chunks = new Map<number, Chunk>();
  readonly #dirty = new Set<number>();
  #journal: ChangedBox[] | null = null;
  // While an edit is open: each touched chunk as it was before its first write.
  #edit: Map<number, Chunk | null> | null = null;
  #cellCount = 0;

  constructor(options: WorldOptions = {}) {
    this.layout = new ChunkLayout(options.chunkBits);
    this.states = options.states ?? new CellStateTable();
  }

  /**
   * A copy of the world that shares every chunk until one side writes to it, and shares the
   * state table. Cheap whatever the world's size: previews and dry runs apply commands to a
   * fork and throw it away.
   */
  fork(): World {
    const copy = new World({ chunkBits: this.layout.bits, states: this.states });
    for (const [key, chunk] of this.#chunks) copy.#chunks.set(key, chunk.clone());
    copy.#cellCount = this.#cellCount;
    return copy;
  }

  /** Starts recording an edit: every chunk is snapshotted before its first write. */
  beginEdit(): void {
    if (this.#edit) throw new Error("An edit is already open");
    this.#edit = new Map();
  }

  /** Ends the open edit and returns the touched chunks before and after it. */
  endEdit(): Edit {
    const before = this.#edit;
    if (!before) throw new Error("No edit is open");
    this.#edit = null;
    const after = new Map<number, Chunk | null>();
    for (const key of before.keys()) after.set(key, this.#chunks.get(key)?.clone() ?? null);
    return { before, after };
  }

  /**
   * Puts snapshotted chunks back (an Edit's `before` to undo it, `after` to redo it). The
   * snapshots stay untouched, so they can be restored again. Marks the chunks and their
   * neighbours dirty and records their boxes as changed, like any edit.
   */
  restore(chunks: ReadonlyMap<number, Chunk | null>): void {
    const L = this.layout;
    for (const [key, snapshot] of chunks) {
      const current = this.#chunks.get(key);
      this.#snapshot(key, current);
      this.#cellCount += (snapshot?.count ?? 0) - (current?.count ?? 0);
      if (snapshot && snapshot.count > 0) this.#chunks.set(key, snapshot.clone());
      else this.#chunks.delete(key);
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const last = L.size - 1;
      this.#markDirty(cx, cy, cz, 0, last, 0, last, 0, last);
      this.#journal?.push({
        x0: cx * L.size,
        y0: cy * L.size,
        z0: cz * L.size,
        x1: cx * L.size + last,
        y1: cy * L.size + last,
        z1: cz * L.size + last,
      });
    }
  }

  #snapshot(key: number, chunk: Chunk | undefined): void {
    if (this.#edit && !this.#edit.has(key)) this.#edit.set(key, chunk?.clone() ?? null);
  }

  /** Number of occupied cells. */
  get cellCount(): number {
    return this.#cellCount;
  }

  /** Number of chunks holding at least one cell. */
  get chunkCount(): number {
    return this.#chunks.size;
  }

  getId(x: number, y: number, z: number): number {
    const L = this.layout;
    L.assertWorldPos(x, y, z);
    const chunk = this.#chunks.get(chunkKey(L.toChunk(x), L.toChunk(y), L.toChunk(z)));
    return chunk ? chunk.get(L.localIndex(L.toLocal(x), L.toLocal(y), L.toLocal(z))) : EMPTY_ID;
  }

  get(x: number, y: number, z: number): CellState | null {
    return this.states.get(this.getId(x, y, z));
  }

  /** Sets a cell to an interned state id (EMPTY_ID clears it). Returns whether anything changed. */
  setId(x: number, y: number, z: number, id: number): boolean {
    const L = this.layout;
    L.assertWorldPos(x, y, z);
    this.#assertState(id);
    const cx = L.toChunk(x);
    const cy = L.toChunk(y);
    const cz = L.toChunk(z);
    const key = chunkKey(cx, cy, cz);
    let chunk = this.#chunks.get(key);
    const lx = L.toLocal(x);
    const ly = L.toLocal(y);
    const lz = L.toLocal(z);
    const index = L.localIndex(lx, ly, lz);
    if (!chunk) {
      if (id === EMPTY_ID) {
        return false;
      }
      this.#snapshot(key, undefined);
      chunk = new Chunk(L);
      this.#chunks.set(key, chunk);
    } else if (this.#edit) {
      if (chunk.get(index) === id) return false;
      this.#snapshot(key, chunk);
    }
    const previous = chunk.set(index, id);
    if (previous === id) {
      return false;
    }
    this.#countChange(previous, id);
    if (chunk.count === 0) {
      this.#chunks.delete(key);
    }
    this.#markDirty(cx, cy, cz, lx, lx, ly, ly, lz, lz);
    this.#journal?.push({ x0: x, y0: y, z0: z, x1: x, y1: y, z1: z });
    return true;
  }

  /** Sets a cell from a state description, or clears it with null. Returns whether anything changed. */
  set(x: number, y: number, z: number, state: CellStateInput | null): boolean {
    return this.setId(x, y, z, state === null ? EMPTY_ID : this.states.intern(state));
  }

  /**
   * Sets every cell in the box between two corners (inclusive, in any order) to one state id,
   * chunk by chunk. EMPTY_ID clears the box. Returns how many cells changed.
   */
  fillBox(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    id: number,
  ): number {
    const L = this.layout;
    L.assertWorldPos(ax, ay, az);
    L.assertWorldPos(bx, by, bz);
    this.#assertState(id);
    const [x0, x1] = ax <= bx ? [ax, bx] : [bx, ax];
    const [y0, y1] = ay <= by ? [ay, by] : [by, ay];
    const [z0, z1] = az <= bz ? [az, bz] : [bz, az];
    const last = L.size - 1;
    let changed = 0;
    for (let cy = L.toChunk(y0); cy <= L.toChunk(y1); cy++) {
      const ly0 = cy === L.toChunk(y0) ? L.toLocal(y0) : 0;
      const ly1 = cy === L.toChunk(y1) ? L.toLocal(y1) : last;
      for (let cz = L.toChunk(z0); cz <= L.toChunk(z1); cz++) {
        const lz0 = cz === L.toChunk(z0) ? L.toLocal(z0) : 0;
        const lz1 = cz === L.toChunk(z1) ? L.toLocal(z1) : last;
        for (let cx = L.toChunk(x0); cx <= L.toChunk(x1); cx++) {
          const lx0 = cx === L.toChunk(x0) ? L.toLocal(x0) : 0;
          const lx1 = cx === L.toChunk(x1) ? L.toLocal(x1) : last;
          const key = chunkKey(cx, cy, cz);
          let chunk = this.#chunks.get(key);
          this.#snapshot(key, chunk);
          if (!chunk) {
            if (id === EMPTY_ID) {
              continue;
            }
            chunk = new Chunk(L);
            this.#chunks.set(key, chunk);
          }
          const before = chunk.count;
          const chunkChanged = chunk.fill(lx0, lx1, ly0, ly1, lz0, lz1, id);
          if (chunkChanged > 0) {
            changed += chunkChanged;
            this.#cellCount += chunk.count - before;
            if (chunk.count === 0) {
              this.#chunks.delete(key);
            }
            this.#markDirty(cx, cy, cz, lx0, lx1, ly0, ly1, lz0, lz1);
          }
        }
      }
    }
    if (changed > 0) this.#journal?.push({ x0, y0, z0, x1, y1, z1 });
    return changed;
  }

  /**
   * Replaces a chunk wholesale from a dense array of state ids in ChunkLayout index order
   * (loading a saved project). Not an edit: it isn't snapshotted, but marks the chunk dirty.
   */
  loadDense(cx: number, cy: number, cz: number, dense: Uint16Array): void {
    const key = chunkKey(cx, cy, cz);
    const chunk = Chunk.fromDense(this.layout, dense);
    this.#cellCount += chunk.count - (this.#chunks.get(key)?.count ?? 0);
    if (chunk.count > 0) this.#chunks.set(key, chunk);
    else this.#chunks.delete(key);
    const last = this.layout.size - 1;
    this.#markDirty(cx, cy, cz, 0, last, 0, last, 0, last);
  }

  /** The chunk with this key (see chunkKey), if it holds any cells. */
  chunkByKey(key: number): Chunk | undefined {
    return this.#chunks.get(key);
  }

  /** The chunk at chunk coordinates, if it holds any cells. */
  chunk(cx: number, cy: number, cz: number): Chunk | undefined {
    return this.#chunks.get(chunkKey(cx, cy, cz));
  }

  /**
   * Writes chunk [cx, cy, cz] plus a one-cell border from its 26 neighbours into `out`, a
   * (size + 2)³ array indexed (x + 1) + (z + 1) * P + (y + 1) * P * P with P = size + 2.
   * Empty space reads EMPTY_ID. This is what the mesher reads: faces, corners and ambient
   * occlusion all depend on cells just across the chunk's edges.
   */
  copyPadded(cx: number, cy: number, cz: number, out: Uint16Array): Uint16Array {
    const L = this.layout;
    const S = L.size;
    const P = S + 2;
    out.fill(EMPTY_ID);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const chunk = this.#chunks.get(chunkKey(cx + dx, cy + dy, cz + dz));
          if (!chunk) continue;
          if (dx === 0 && dy === 0 && dz === 0) {
            const dense = chunk.copyTo(this.#scratch(L.volume));
            for (let y = 0; y < S; y++) {
              for (let z = 0; z < S; z++) {
                const from = L.localIndex(0, y, z);
                out.set(dense.subarray(from, from + S), 1 + (z + 1) * P + (y + 1) * P * P);
              }
            }
            continue;
          }
          // Only the neighbour's cells touching this chunk: one layer on each offset axis.
          const [x0, x1] = dx < 0 ? [S - 1, S - 1] : dx > 0 ? [0, 0] : [0, S - 1];
          const [y0, y1] = dy < 0 ? [S - 1, S - 1] : dy > 0 ? [0, 0] : [0, S - 1];
          const [z0, z1] = dz < 0 ? [S - 1, S - 1] : dz > 0 ? [0, 0] : [0, S - 1];
          for (let y = y0; y <= y1; y++) {
            const py = dy < 0 ? 0 : dy > 0 ? S + 1 : y + 1;
            for (let z = z0; z <= z1; z++) {
              const pz = dz < 0 ? 0 : dz > 0 ? S + 1 : z + 1;
              for (let x = x0; x <= x1; x++) {
                const px = dx < 0 ? 0 : dx > 0 ? S + 1 : x + 1;
                out[px + pz * P + py * P * P] = chunk.get(L.localIndex(x, y, z));
              }
            }
          }
        }
      }
    }
    return out;
  }

  #scratchCells: Uint16Array | null = null;

  #scratch(length: number): Uint16Array {
    if (!this.#scratchCells || this.#scratchCells.length !== length) {
      this.#scratchCells = new Uint16Array(length);
    }
    return this.#scratchCells;
  }

  chunkKeys(): IterableIterator<number> {
    return this.#chunks.keys();
  }

  /** Visits every occupied cell, chunk by chunk, in no particular order. */
  forEachCell(visit: (x: number, y: number, z: number, id: number) => void): void {
    const L = this.layout;
    const zShift = L.bits;
    const yShift = 2 * L.bits;
    for (const [key, chunk] of this.#chunks) {
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const ox = cx * L.size;
      const oy = cy * L.size;
      const oz = cz * L.size;
      chunk.forEachOccupied((i, id) => {
        visit(ox + (i & L.mask), oy + (i >> yShift), oz + ((i >> zShift) & L.mask), id);
      });
    }
  }

  /** Bytes held by chunk cell storage. */
  get memoryBytes(): number {
    let bytes = 0;
    for (const chunk of this.#chunks.values()) bytes += chunk.memoryBytes;
    return bytes;
  }

  /** How many chunks are dirty and waiting for takeDirtyChunks(). */
  get dirtyCount(): number {
    return this.#dirty.size;
  }

  /**
   * Keys of every chunk whose meshes may be stale since the last call: chunks with changed
   * cells, plus face neighbours of changes that touched a chunk's boundary (their exposed
   * faces depend on it). Keys of chunks that are now empty are included. The renderer
   * drains this once per frame.
   */
  takeDirtyChunks(): number[] {
    const keys = [...this.#dirty];
    this.#dirty.clear();
    return keys;
  }

  /**
   * Starts or stops recording the boxes that edits change, for takeChanges(). Derived data
   * that needs exact positions (lighting) turns this on; it costs nothing while off.
   */
  recordChanges(on: boolean): void {
    this.#journal = on ? [] : null;
  }

  /** Boxes changed since the last call (inclusive corners), oldest first. */
  takeChanges(): ChangedBox[] {
    const changes = this.#journal ?? [];
    if (this.#journal) this.#journal = [];
    return changes;
  }

  #assertState(id: number): void {
    if (!this.states.has(id)) {
      throw new RangeError(`Unknown cell state id ${id}`);
    }
  }

  #countChange(previous: number, id: number): void {
    if (previous === EMPTY_ID) {
      this.#cellCount++;
    } else if (id === EMPTY_ID) {
      this.#cellCount--;
    }
  }

  #markDirty(
    cx: number,
    cy: number,
    cz: number,
    lx0: number,
    lx1: number,
    ly0: number,
    ly1: number,
    lz0: number,
    lz1: number,
  ): void {
    const last = this.layout.size - 1;
    const dirty = this.#dirty;
    dirty.add(chunkKey(cx, cy, cz));
    if (lx0 === 0) dirty.add(chunkKey(cx - 1, cy, cz));
    if (lx1 === last) dirty.add(chunkKey(cx + 1, cy, cz));
    if (ly0 === 0) dirty.add(chunkKey(cx, cy - 1, cz));
    if (ly1 === last) dirty.add(chunkKey(cx, cy + 1, cz));
    if (lz0 === 0) dirty.add(chunkKey(cx, cy, cz - 1));
    if (lz1 === last) dirty.add(chunkKey(cx, cy, cz + 1));
  }
}
