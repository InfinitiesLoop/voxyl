import { EMPTY_ID } from "./cell-state.ts";
import type { ChunkLayout } from "./coords.ts";

/** Palette slots per chunk (slot 0 is empty) before its bricks switch to 16-bit ids. */
const PALETTE_LIMIT = 256;

/**
 * A cubic block of cell-state ids whose memory follows its contents, not its volume. The
 * chunk is split into bricks (16³, or the whole chunk if smaller). A brick is either empty
 * (no memory), uniform (one id, no array), or an array of one-byte indices into the chunk's
 * palette of up to 255 states. If a chunk ever needs more states than that, its bricks switch
 * to two-byte ids. Cells are addressed by ChunkLayout.localIndex() like a dense array.
 */
export class Chunk {
  readonly #bits: number;
  readonly #mask: number;
  readonly #brickBits: number;
  readonly #brickMask: number;
  readonly #brickSize: number;
  readonly #brickVolume: number;
  readonly #bricksPerAxis: number;
  readonly #volume: number;
  // Per brick: its id when it has no array (EMPTY_ID for empty), its array, occupied cells.
  readonly #uniform: Uint16Array;
  readonly #data: (Uint8Array | Uint16Array | null)[];
  readonly #occupied: Uint16Array;
  #count = 0;
  // 8-bit mode: slot -> id, id -> slot, and how many array cells use each slot.
  #wide = false;
  readonly #palette: number[] = [EMPTY_ID];
  readonly #slots = new Map<number, number>();
  readonly #refs: number[] = [0];
  readonly #freeSlots: number[] = [];

  constructor(layout: ChunkLayout) {
    this.#bits = layout.bits;
    this.#mask = layout.mask;
    this.#brickBits = layout.brickBits;
    this.#brickSize = layout.brickSize;
    this.#brickMask = layout.brickSize - 1;
    this.#brickVolume = layout.brickVolume;
    this.#bricksPerAxis = layout.bricksPerAxis;
    this.#volume = layout.volume;
    const bricks = layout.bricksPerAxis ** 3;
    this.#uniform = new Uint16Array(bricks);
    this.#data = new Array(bricks).fill(null);
    this.#occupied = new Uint16Array(bricks);
  }

  /** Number of occupied cells. */
  get count(): number {
    return this.#count;
  }

  /** Bytes held by cell storage. */
  get memoryBytes(): number {
    let bytes = this.#uniform.byteLength + this.#occupied.byteLength + this.#palette.length * 8;
    for (const data of this.#data) if (data) bytes += data.byteLength;
    return bytes;
  }

  get(index: number): number {
    const lx = index & this.#mask;
    const lz = (index >> this.#bits) & this.#mask;
    const ly = index >> (2 * this.#bits);
    const bb = this.#brickBits;
    const n = this.#bricksPerAxis;
    const brick = (lx >> bb) + (lz >> bb) * n + (ly >> bb) * n * n;
    const data = this.#data[brick];
    if (!data) return this.#uniform[brick] ?? EMPTY_ID;
    const bm = this.#brickMask;
    const raw = data[(lx & bm) + ((lz & bm) << bb) + ((ly & bm) << (2 * bb))] ?? 0;
    return this.#wide ? raw : (this.#palette[raw] ?? EMPTY_ID);
  }

  /** Sets one cell and returns the id that was there. */
  set(index: number, id: number): number {
    const lx = index & this.#mask;
    const lz = (index >> this.#bits) & this.#mask;
    const ly = index >> (2 * this.#bits);
    const bb = this.#brickBits;
    const n = this.#bricksPerAxis;
    const brick = (lx >> bb) + (lz >> bb) * n + (ly >> bb) * n * n;
    const bm = this.#brickMask;
    const inner = (lx & bm) + ((lz & bm) << bb) + ((ly & bm) << (2 * bb));
    return this.#setInBrick(brick, inner, id);
  }

  /**
   * Sets every cell in a box of local coordinates (inclusive) to `id`. Bricks the box covers
   * completely become uniform without touching their cells. Returns how many cells changed.
   */
  fill(
    lx0: number,
    lx1: number,
    ly0: number,
    ly1: number,
    lz0: number,
    lz1: number,
    id: number,
  ): number {
    const bb = this.#brickBits;
    const bs = this.#brickSize;
    const n = this.#bricksPerAxis;
    let changed = 0;
    for (let by = ly0 >> bb; by <= ly1 >> bb; by++) {
      const y0 = Math.max(ly0, by * bs) - by * bs;
      const y1 = Math.min(ly1, by * bs + bs - 1) - by * bs;
      for (let bz = lz0 >> bb; bz <= lz1 >> bb; bz++) {
        const z0 = Math.max(lz0, bz * bs) - bz * bs;
        const z1 = Math.min(lz1, bz * bs + bs - 1) - bz * bs;
        for (let bx = lx0 >> bb; bx <= lx1 >> bb; bx++) {
          const x0 = Math.max(lx0, bx * bs) - bx * bs;
          const x1 = Math.min(lx1, bx * bs + bs - 1) - bx * bs;
          const brick = bx + bz * n + by * n * n;
          if (x0 === 0 && y0 === 0 && z0 === 0 && x1 === bs - 1 && y1 === bs - 1 && z1 === bs - 1) {
            changed += this.#fillBrick(brick, id);
          } else {
            for (let y = y0; y <= y1; y++) {
              for (let z = z0; z <= z1; z++) {
                let inner = x0 + (z << bb) + (y << (2 * bb));
                for (let x = x0; x <= x1; x++, inner++) {
                  if (this.#setInBrick(brick, inner, id) !== id) changed++;
                }
              }
            }
          }
        }
      }
    }
    return changed;
  }

  /** Writes every cell, empty ones as EMPTY_ID, into `out` in ChunkLayout index order. */
  copyTo(out: Uint16Array): Uint16Array {
    const bb = this.#brickBits;
    const bs = this.#brickSize;
    const n = this.#bricksPerAxis;
    const strideZ = 1 << this.#bits;
    const strideY = 1 << (2 * this.#bits);
    for (let by = 0; by < n; by++) {
      for (let bz = 0; bz < n; bz++) {
        for (let bx = 0; bx < n; bx++) {
          const brick = bx + bz * n + by * n * n;
          const data = this.#data[brick];
          const uniform = this.#uniform[brick] ?? EMPTY_ID;
          for (let y = 0; y < bs; y++) {
            for (let z = 0; z < bs; z++) {
              const start = bx * bs + (bz * bs + z) * strideZ + (by * bs + y) * strideY;
              if (!data) {
                out.fill(uniform, start, start + bs);
                continue;
              }
              const row = (z << bb) + (y << (2 * bb));
              for (let x = 0; x < bs; x++) {
                const raw = data[row + x] ?? 0;
                out[start + x] = this.#wide ? raw : (this.#palette[raw] ?? EMPTY_ID);
              }
            }
          }
        }
      }
    }
    return out;
  }

  /** A dense copy of the chunk, in ChunkLayout index order. */
  toArray(): Uint16Array {
    return this.copyTo(new Uint16Array(this.#volume));
  }

  /** Visits every occupied cell with its ChunkLayout index. */
  forEachOccupied(visit: (index: number, id: number) => void): void {
    const bb = this.#brickBits;
    const bs = this.#brickSize;
    const n = this.#bricksPerAxis;
    const strideZ = 1 << this.#bits;
    const strideY = 1 << (2 * this.#bits);
    for (let brick = 0; brick < this.#data.length; brick++) {
      if ((this.#occupied[brick] ?? 0) === 0) continue;
      const bx = brick % n;
      const bz = Math.floor(brick / n) % n;
      const by = Math.floor(brick / (n * n));
      const data = this.#data[brick];
      const uniform = this.#uniform[brick] ?? EMPTY_ID;
      for (let y = 0; y < bs; y++) {
        for (let z = 0; z < bs; z++) {
          const start = bx * bs + (bz * bs + z) * strideZ + (by * bs + y) * strideY;
          const row = (z << bb) + (y << (2 * bb));
          for (let x = 0; x < bs; x++) {
            let id = uniform;
            if (data) {
              const raw = data[row + x] ?? 0;
              id = this.#wide ? raw : (this.#palette[raw] ?? EMPTY_ID);
            }
            if (id !== EMPTY_ID) visit(start + x, id);
          }
        }
      }
    }
  }

  #setInBrick(brick: number, inner: number, id: number): number {
    let data = this.#data[brick];
    if (!data) {
      const uniform = this.#uniform[brick] ?? EMPTY_ID;
      if (uniform === id) return id;
      data = this.#materialize(brick, uniform);
    }
    const raw = data[inner] ?? 0;
    const previous = this.#wide ? raw : (this.#palette[raw] ?? EMPTY_ID);
    if (previous === id) return previous;

    if (this.#wide) {
      data[inner] = id;
    } else {
      const slot = this.#slotFor(id);
      if (this.#wide) {
        // Taking a slot overflowed the palette: every brick is 16-bit now.
        data = this.#data[brick] ?? data;
        data[inner] = id;
      } else {
        data[inner] = slot;
        if (slot !== 0) this.#refs[slot] = (this.#refs[slot] ?? 0) + 1;
        if (raw !== 0) this.#release(raw, 1);
      }
    }

    if (previous === EMPTY_ID) {
      this.#occupied[brick] = (this.#occupied[brick] ?? 0) + 1;
      this.#count++;
    } else if (id === EMPTY_ID) {
      this.#occupied[brick] = (this.#occupied[brick] ?? 1) - 1;
      this.#count--;
      if (this.#occupied[brick] === 0) {
        this.#data[brick] = null;
        this.#uniform[brick] = EMPTY_ID;
      }
    }
    return previous;
  }

  /** Makes a whole brick `id`, dropping its array. Returns how many cells changed. */
  #fillBrick(brick: number, id: number): number {
    const volume = this.#brickVolume;
    const data = this.#data[brick];
    let changed: number;
    if (!data) {
      changed = (this.#uniform[brick] ?? EMPTY_ID) === id ? 0 : volume;
    } else {
      changed = 0;
      for (let i = 0; i < volume; i++) {
        const raw = data[i] ?? 0;
        const previous = this.#wide ? raw : (this.#palette[raw] ?? EMPTY_ID);
        if (previous !== id) changed++;
        if (!this.#wide && raw !== 0) this.#release(raw, 1);
      }
    }
    const before = this.#occupied[brick] ?? 0;
    const after = id === EMPTY_ID ? 0 : volume;
    this.#count += after - before;
    this.#occupied[brick] = after;
    this.#data[brick] = null;
    this.#uniform[brick] = id;
    return changed;
  }

  /** Gives a uniform brick an array, filled with its id. */
  #materialize(brick: number, uniform: number): Uint8Array | Uint16Array {
    const volume = this.#brickVolume;
    if (!this.#wide) {
      const slot = uniform === EMPTY_ID ? 0 : this.#slotFor(uniform);
      if (!this.#wide) {
        const data = new Uint8Array(volume);
        if (slot !== 0) {
          data.fill(slot);
          this.#refs[slot] = (this.#refs[slot] ?? 0) + volume;
        }
        this.#data[brick] = data;
        return data;
      }
    }
    const data = new Uint16Array(volume);
    if (uniform !== EMPTY_ID) data.fill(uniform);
    this.#data[brick] = data;
    return data;
  }

  /** The palette slot for `id`, taking a free one if needed; widens the chunk when full. */
  #slotFor(id: number): number {
    if (id === EMPTY_ID) return 0;
    const existing = this.#slots.get(id);
    if (existing !== undefined) return existing;
    let slot = this.#freeSlots.pop();
    if (slot === undefined) {
      if (this.#palette.length >= PALETTE_LIMIT) {
        this.#widen();
        return -1;
      }
      slot = this.#palette.length;
      this.#palette.push(id);
      this.#refs.push(0);
    } else {
      this.#palette[slot] = id;
      this.#refs[slot] = 0;
    }
    this.#slots.set(id, slot);
    return slot;
  }

  #release(slot: number, cells: number): void {
    const refs = (this.#refs[slot] ?? 0) - cells;
    this.#refs[slot] = refs;
    if (refs === 0) {
      this.#slots.delete(this.#palette[slot] ?? EMPTY_ID);
      this.#freeSlots.push(slot);
    }
  }

  #widen(): void {
    for (let brick = 0; brick < this.#data.length; brick++) {
      const data = this.#data[brick];
      if (!data) continue;
      const wide = new Uint16Array(data.length);
      for (let i = 0; i < data.length; i++) wide[i] = this.#palette[data[i] ?? 0] ?? EMPTY_ID;
      this.#data[brick] = wide;
    }
    this.#wide = true;
    this.#palette.length = 1;
    this.#refs.length = 1;
    this.#slots.clear();
    this.#freeSlots.length = 0;
  }
}
