import { type CellState, type CellStateInput, CellStateTable, EMPTY_ID } from "./cell-state.ts";
import { Chunk } from "./chunk.ts";
import { ChunkLayout, chunkKey, chunkKeyToCoords } from "./coords.ts";

export interface WorldOptions {
  /** Chunk edge length as a power of two (5 = 32 cells). */
  readonly chunkBits?: number;
}

/**
 * The single source of truth for a project's cells (the web counterpart of VoxelData).
 * Views, meshers and tools all read and write through it; none of them owns cell data.
 */
export class World {
  readonly layout: ChunkLayout;
  readonly states = new CellStateTable();
  readonly #chunks = new Map<number, Chunk>();
  readonly #dirty = new Set<number>();
  #cellCount = 0;

  constructor(options: WorldOptions = {}) {
    this.layout = new ChunkLayout(options.chunkBits);
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
    if (!chunk) {
      if (id === EMPTY_ID) {
        return false;
      }
      chunk = new Chunk(L.volume);
      this.#chunks.set(key, chunk);
    }
    const lx = L.toLocal(x);
    const ly = L.toLocal(y);
    const lz = L.toLocal(z);
    const previous = chunk.set(L.localIndex(lx, ly, lz), id);
    if (previous === id) {
      return false;
    }
    this.#countChange(previous, id);
    if (chunk.count === 0) {
      this.#chunks.delete(key);
    }
    this.#markDirty(cx, cy, cz, lx, lx, ly, ly, lz, lz);
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
          if (!chunk) {
            if (id === EMPTY_ID) {
              continue;
            }
            chunk = new Chunk(L.volume);
            this.#chunks.set(key, chunk);
          }
          let chunkChanged = 0;
          for (let ly = ly0; ly <= ly1; ly++) {
            for (let lz = lz0; lz <= lz1; lz++) {
              let index = L.localIndex(lx0, ly, lz);
              for (let lx = lx0; lx <= lx1; lx++, index++) {
                const previous = chunk.set(index, id);
                if (previous !== id) {
                  chunkChanged++;
                  this.#countChange(previous, id);
                }
              }
            }
          }
          if (chunkChanged > 0) {
            changed += chunkChanged;
            if (chunk.count === 0) {
              this.#chunks.delete(key);
            }
            this.#markDirty(cx, cy, cz, lx0, lx1, ly0, ly1, lz0, lz1);
          }
        }
      }
    }
    return changed;
  }

  /** The chunk at chunk coordinates, if it holds any cells. Meshers read `cells` directly. */
  chunk(cx: number, cy: number, cz: number): Chunk | undefined {
    return this.#chunks.get(chunkKey(cx, cy, cz));
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
      const cells = chunk.cells;
      for (let i = 0; i < cells.length; i++) {
        const id = cells[i] ?? EMPTY_ID;
        if (id !== EMPTY_ID) {
          visit(
            cx * L.size + (i & L.mask),
            cy * L.size + (i >> yShift),
            cz * L.size + ((i >> zShift) & L.mask),
            id,
          );
        }
      }
    }
  }

  /**
   * Keys of every chunk whose meshes may be stale since the last call: chunks with changed
   * cells, plus face neighbours of changes that touched a chunk's boundary (their exposed
   * faces depend on it). Keys of chunks that are now empty are included. The renderer
   * drains this once per frame.
   */
  /** How many chunks are dirty and waiting for takeDirtyChunks(). */
  get dirtyCount(): number {
    return this.#dirty.size;
  }

  takeDirtyChunks(): number[] {
    const keys = [...this.#dirty];
    this.#dirty.clear();
    return keys;
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
