import { EMPTY_ID } from "./cell-state.ts";
import { CHUNK_VOLUME } from "./coords.ts";

/** A dense 32x32x32 block of cell-state ids. Index with localIndex(). */
export class Chunk {
  readonly cells = new Uint16Array(CHUNK_VOLUME);
  #count = 0;

  /** Number of occupied cells. */
  get count(): number {
    return this.#count;
  }

  get(index: number): number {
    return this.cells[index] ?? EMPTY_ID;
  }

  /** Sets one cell and returns the id that was there. */
  set(index: number, id: number): number {
    const previous = this.cells[index] ?? EMPTY_ID;
    if (previous === id) {
      return previous;
    }
    this.cells[index] = id;
    if (previous === EMPTY_ID) {
      this.#count++;
    } else if (id === EMPTY_ID) {
      this.#count--;
    }
    return previous;
  }
}
