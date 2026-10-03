import { type CellState, type CellStateInput, CellStateTable, EMPTY_ID } from "./cell-state.ts";
import { Chunk } from "./chunk.ts";
import {
  assertWorldPos,
  CHUNK_BITS,
  CHUNK_MASK,
  CHUNK_SIZE,
  chunkKey,
  chunkKeyToCoords,
  localIndex,
  toChunk,
  toLocal,
} from "./coords.ts";

/**
 * The single source of truth for a project's cells (the web counterpart of VoxelData).
 * Views, meshers and tools all read and write through it; none of them owns cell data.
 */
export class World {
  readonly states = new CellStateTable();
  readonly #chunks = new Map<number, Chunk>();
  readonly #dirty = new Set<number>();
  #cellCount = 0;

  /** Number of occupied cells. */
  get cellCount(): number {
    return this.#cellCount;
  }

  /** Number of chunks holding at least one cell. */
  get chunkCount(): number {
    return this.#chunks.size;
  }

  getId(x: number, y: number, z: number): number {
    assertWorldPos(x, y, z);
    const chunk = this.#chunks.get(chunkKey(toChunk(x), toChunk(y), toChunk(z)));
    return chunk ? chunk.get(localIndex(toLocal(x), toLocal(y), toLocal(z))) : EMPTY_ID;
  }

  get(x: number, y: number, z: number): CellState | null {
    return this.states.get(this.getId(x, y, z));
  }

  /** Sets a cell to an interned state id (EMPTY_ID clears it). Returns whether anything changed. */
  setId(x: number, y: number, z: number, id: number): boolean {
    assertWorldPos(x, y, z);
    if (!this.states.has(id)) {
      throw new RangeError(`Unknown cell state id ${id}`);
    }
    const key = chunkKey(toChunk(x), toChunk(y), toChunk(z));
    let chunk = this.#chunks.get(key);
    if (!chunk) {
      if (id === EMPTY_ID) {
        return false;
      }
      chunk = new Chunk();
      this.#chunks.set(key, chunk);
    }
    const previous = chunk.set(localIndex(toLocal(x), toLocal(y), toLocal(z)), id);
    if (previous === id) {
      return false;
    }
    if (previous === EMPTY_ID) {
      this.#cellCount++;
    } else if (id === EMPTY_ID) {
      this.#cellCount--;
    }
    if (chunk.count === 0) {
      this.#chunks.delete(key);
    }
    this.#dirty.add(key);
    return true;
  }

  /** Sets a cell from a state description, or clears it with null. Returns whether anything changed. */
  set(x: number, y: number, z: number, state: CellStateInput | null): boolean {
    return this.setId(x, y, z, state === null ? EMPTY_ID : this.states.intern(state));
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
    for (const [key, chunk] of this.#chunks) {
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const cells = chunk.cells;
      for (let i = 0; i < cells.length; i++) {
        const id = cells[i] ?? EMPTY_ID;
        if (id !== EMPTY_ID) {
          visit(
            cx * CHUNK_SIZE + (i & CHUNK_MASK),
            cy * CHUNK_SIZE + (i >> (2 * CHUNK_BITS)),
            cz * CHUNK_SIZE + ((i >> CHUNK_BITS) & CHUNK_MASK),
            id,
          );
        }
      }
    }
  }

  /**
   * Keys of every chunk changed since the last call, including chunks that emptied and were
   * dropped. The mesher drains this once per frame.
   */
  takeDirtyChunks(): number[] {
    const keys = [...this.#dirty];
    this.#dirty.clear();
    return keys;
  }
}
