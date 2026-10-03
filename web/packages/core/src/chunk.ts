import { EMPTY_ID } from "./cell-state.ts";

/** A dense cubic block of cell-state ids. Index with ChunkLayout.localIndex(). */
export class Chunk {
  readonly cells: Uint16Array;
  #count = 0;

  constructor(volume: number) {
    this.cells = new Uint16Array(volume);
  }

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
