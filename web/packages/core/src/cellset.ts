// A set of cell positions (empty or not), for regions and the selection (web-core.md,
// section 5). Sparse at two levels: 128³ blocks keyed like chunks, each holding 8³ bricks that
// are either full (no memory) or a 512-bit mask. A box of a million cells is a few thousand
// full bricks, and set operations work a word or a whole brick at a time.

import { type Box, unionBox } from "./box.ts";

const BLOCK_BITS = 7;
const BRICK_BITS = 3;
const BRICKS = 1 << (BLOCK_BITS - BRICK_BITS); // per block edge: 16
const WORDS = 16; // 512 bits
const FULL = "full" as const;
type Brick = Uint32Array | typeof FULL;

// Block keys pack three 17-bit coordinates, as chunk keys do (blocks are 128-cell chunks).
const SPAN = 2 ** 17;
const OFFSET = 2 ** 16;
const blockKey = (bx: number, by: number, bz: number) =>
  ((bx + OFFSET) * SPAN + (by + OFFSET)) * SPAN + (bz + OFFSET);
function blockCoords(key: number): [number, number, number] {
  const bz = (key % SPAN) - OFFSET;
  const rest = Math.floor(key / SPAN);
  return [Math.floor(rest / SPAN) - OFFSET, (rest % SPAN) - OFFSET, bz];
}
const brickIndex = (x: number, y: number, z: number) =>
  ((x >> BRICK_BITS) & (BRICKS - 1)) +
  ((z >> BRICK_BITS) & (BRICKS - 1)) * BRICKS +
  ((y >> BRICK_BITS) & (BRICKS - 1)) * BRICKS * BRICKS;
const bitIndex = (x: number, y: number, z: number) => (x & 7) + (z & 7) * 8 + (y & 7) * 64;

function popcount(v: number): number {
  let n = v - ((v >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
const count = (b: Brick) => (b === FULL ? 512 : b.reduce((s, w) => s + popcount(w), 0));

/** A brick's origin and contents, as iterated. */
export interface BrickView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** All 512 cells are in the set. */
  readonly full: boolean;
  has(bit: number): boolean;
}

export class CellSet {
  readonly #blocks = new Map<number, Map<number, Brick>>();
  #size = 0;

  /** Every cell of a box. */
  static ofBox(box: Box): CellSet {
    const set = new CellSet();
    set.addBox(box);
    return set;
  }

  get size(): number {
    return this.#size;
  }

  has(x: number, y: number, z: number): boolean {
    const brick = this.#blocks
      .get(blockKey(x >> BLOCK_BITS, y >> BLOCK_BITS, z >> BLOCK_BITS))
      ?.get(brickIndex(x, y, z));
    if (!brick) return false;
    if (brick === FULL) return true;
    const bit = bitIndex(x, y, z);
    return ((brick[bit >> 5] ?? 0) & (1 << (bit & 31))) !== 0;
  }

  add(x: number, y: number, z: number): void {
    const bricks = this.#bricks(x, y, z, true);
    const i = brickIndex(x, y, z);
    let brick = bricks.get(i);
    if (brick === FULL) return;
    if (!brick) {
      brick = new Uint32Array(WORDS);
      bricks.set(i, brick);
    }
    const bit = bitIndex(x, y, z);
    const word = brick[bit >> 5] ?? 0;
    const m = 1 << (bit & 31);
    if (word & m) return;
    brick[bit >> 5] = word | m;
    this.#size++;
    if (brick.every((w) => w === 0xffffffff)) bricks.set(i, FULL);
  }

  delete(x: number, y: number, z: number): void {
    const key = blockKey(x >> BLOCK_BITS, y >> BLOCK_BITS, z >> BLOCK_BITS);
    const bricks = this.#blocks.get(key);
    const i = brickIndex(x, y, z);
    let brick = bricks?.get(i);
    if (!bricks || !brick) return;
    if (brick === FULL) {
      brick = new Uint32Array(WORDS).fill(0xffffffff);
      bricks.set(i, brick);
    }
    const bit = bitIndex(x, y, z);
    const word = brick[bit >> 5] ?? 0;
    const m = 1 << (bit & 31);
    if (!(word & m)) return;
    brick[bit >> 5] = word & ~m;
    this.#size--;
    if (brick.every((w) => w === 0)) this.#drop(bricks, key, i);
  }

  /** Adds every cell of a box; bricks it covers completely become full without touching bits. */
  addBox(box: Box): void {
    for (let by = box.y0 >> BRICK_BITS; by <= box.y1 >> BRICK_BITS; by++) {
      const y0 = Math.max(box.y0, by << BRICK_BITS);
      const y1 = Math.min(box.y1, (by << BRICK_BITS) + 7);
      for (let bz = box.z0 >> BRICK_BITS; bz <= box.z1 >> BRICK_BITS; bz++) {
        const z0 = Math.max(box.z0, bz << BRICK_BITS);
        const z1 = Math.min(box.z1, (bz << BRICK_BITS) + 7);
        for (let bx = box.x0 >> BRICK_BITS; bx <= box.x1 >> BRICK_BITS; bx++) {
          const x0 = Math.max(box.x0, bx << BRICK_BITS);
          const x1 = Math.min(box.x1, (bx << BRICK_BITS) + 7);
          if (x1 - x0 === 7 && y1 - y0 === 7 && z1 - z0 === 7) {
            const bricks = this.#bricks(x0, y0, z0, true);
            const i = brickIndex(x0, y0, z0);
            const before = bricks.get(i);
            this.#size += 512 - (before ? count(before) : 0);
            bricks.set(i, FULL);
            continue;
          }
          for (let y = y0; y <= y1; y++)
            for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.add(x, y, z);
        }
      }
    }
  }

  /** Visits every cell, block by block and brick by brick in a fixed order. */
  forEach(visit: (x: number, y: number, z: number) => void): void {
    for (const b of this.bricks()) {
      for (let bit = 0; bit < 512; bit++) {
        if (b.full || b.has(bit)) visit(b.x + (bit & 7), b.y + (bit >> 6), b.z + ((bit >> 3) & 7));
      }
    }
  }

  /** The non-empty bricks, in a fixed order (sorted by block key, then brick index). */
  *bricks(): IterableIterator<BrickView> {
    for (const key of [...this.#blocks.keys()].sort((a, b) => a - b)) {
      const bricks = this.#blocks.get(key);
      if (!bricks) continue;
      const [bx, by, bz] = blockCoords(key);
      for (const i of [...bricks.keys()].sort((a, b) => a - b)) {
        const brick = bricks.get(i);
        if (!brick) continue;
        yield {
          x: (bx << BLOCK_BITS) + (i % BRICKS) * 8,
          y: (by << BLOCK_BITS) + Math.floor(i / (BRICKS * BRICKS)) * 8,
          z: (bz << BLOCK_BITS) + (Math.floor(i / BRICKS) % BRICKS) * 8,
          full: brick === FULL,
          has: (bit) => brick === FULL || ((brick[bit >> 5] ?? 0) & (1 << (bit & 31))) !== 0,
        };
      }
    }
  }

  /** The smallest box holding every cell, or null when empty. */
  bounds(): Box | null {
    let box: Box | null = null;
    for (const b of this.bricks()) {
      if (b.full) {
        box = unionBox(box, { x0: b.x, y0: b.y, z0: b.z, x1: b.x + 7, y1: b.y + 7, z1: b.z + 7 });
        continue;
      }
      for (let bit = 0; bit < 512; bit++) {
        if (!b.has(bit)) continue;
        const x = b.x + (bit & 7);
        const y = b.y + (bit >> 6);
        const z = b.z + ((bit >> 3) & 7);
        box = unionBox(box, { x0: x, y0: y, z0: z, x1: x, y1: y, z1: z });
      }
    }
    return box;
  }

  clone(): CellSet {
    const copy = new CellSet();
    for (const [key, bricks] of this.#blocks) {
      const out = new Map<number, Brick>();
      for (const [i, b] of bricks) out.set(i, b === FULL ? FULL : b.slice());
      copy.#blocks.set(key, out);
    }
    copy.#size = this.#size;
    return copy;
  }

  /** Adds every cell of another set (union, in place). */
  addAll(other: CellSet): this {
    for (const [key, theirs] of other.#blocks) {
      let mine = this.#blocks.get(key);
      if (!mine) {
        mine = new Map();
        this.#blocks.set(key, mine);
      }
      for (const [i, b] of theirs) {
        const a = mine.get(i);
        if (a === FULL) continue;
        if (b === FULL) {
          this.#size += 512 - (a ? count(a) : 0);
          mine.set(i, FULL);
          continue;
        }
        const merged = a ? a.slice() : new Uint32Array(WORDS);
        for (let w = 0; w < WORDS; w++) merged[w] = (merged[w] ?? 0) | (b[w] ?? 0);
        this.#size += count(merged) - (a ? count(a) : 0);
        mine.set(i, merged.every((v) => v === 0xffffffff) ? FULL : merged);
      }
    }
    return this;
  }

  /** Keeps only cells also in another set (intersection, in place). */
  retainAll(other: CellSet): this {
    for (const [key, mine] of [...this.#blocks]) {
      const theirs = other.#blocks.get(key);
      for (const [i, a] of [...mine]) {
        const b = theirs?.get(i);
        if (b === FULL) continue;
        if (!b) {
          this.#size -= count(a);
          this.#drop(mine, key, i);
          continue;
        }
        const kept = a === FULL ? b.slice() : a.map((w, k) => w & (b[k] ?? 0));
        this.#size += count(kept) - count(a);
        if (kept.every((v) => v === 0)) this.#drop(mine, key, i);
        else mine.set(i, kept);
      }
    }
    return this;
  }

  /** Removes every cell of another set (difference, in place). */
  removeAll(other: CellSet): this {
    for (const [key, theirs] of other.#blocks) {
      const mine = this.#blocks.get(key);
      if (!mine) continue;
      for (const [i, b] of theirs) {
        const a = mine.get(i);
        if (!a) continue;
        if (b === FULL) {
          this.#size -= count(a);
          this.#drop(mine, key, i);
          continue;
        }
        const base = a === FULL ? new Uint32Array(WORDS).fill(0xffffffff) : a;
        const kept = base.map((w, k) => w & ~(b[k] ?? 0));
        this.#size += count(kept) - count(a);
        if (kept.every((v) => v === 0)) this.#drop(mine, key, i);
        else mine.set(i, kept);
      }
    }
    return this;
  }

  /** A new set grown by `steps` cells through faces (each step adds the 6 neighbours). */
  grown(steps: number): CellSet {
    let current: CellSet = this.clone();
    for (let s = 0; s < steps; s++) {
      const next = current.clone();
      for (const b of current.bricks()) {
        if (b.full) {
          const { x, y, z } = b;
          next.addBox({ x0: x - 1, y0: y, z0: z, x1: x + 8, y1: y + 7, z1: z + 7 });
          next.addBox({ x0: x, y0: y - 1, z0: z, x1: x + 7, y1: y + 8, z1: z + 7 });
          next.addBox({ x0: x, y0: y, z0: z - 1, x1: x + 7, y1: y + 7, z1: z + 8 });
          continue;
        }
        for (let bit = 0; bit < 512; bit++) {
          if (!b.has(bit)) continue;
          const x = b.x + (bit & 7);
          const y = b.y + (bit >> 6);
          const z = b.z + ((bit >> 3) & 7);
          next.add(x - 1, y, z);
          next.add(x + 1, y, z);
          next.add(x, y - 1, z);
          next.add(x, y + 1, z);
          next.add(x, y, z - 1);
          next.add(x, y, z + 1);
        }
      }
      current = next;
    }
    return current;
  }

  /** A new set shrunk by `steps`: each step keeps only cells whose 6 neighbours are all in. */
  shrunk(steps: number): CellSet {
    let current: CellSet = this;
    for (let s = 0; s < steps; s++) {
      const prev = current;
      const next = new CellSet();
      prev.forEach((x, y, z) => {
        if (
          prev.has(x - 1, y, z) &&
          prev.has(x + 1, y, z) &&
          prev.has(x, y - 1, z) &&
          prev.has(x, y + 1, z) &&
          prev.has(x, y, z - 1) &&
          prev.has(x, y, z + 1)
        ) {
          next.add(x, y, z);
        }
      });
      current = next;
    }
    return current === this ? this.clone() : current;
  }

  #bricks(x: number, y: number, z: number, create: true): Map<number, Brick> {
    const key = blockKey(x >> BLOCK_BITS, y >> BLOCK_BITS, z >> BLOCK_BITS);
    let bricks = this.#blocks.get(key);
    if (!bricks && create) {
      bricks = new Map();
      this.#blocks.set(key, bricks);
    }
    return bricks as Map<number, Brick>;
  }

  #drop(bricks: Map<number, Brick>, key: number, i: number): void {
    bricks.delete(i);
    if (bricks.size === 0) this.#blocks.delete(key);
  }
}
