import { type ChangedBox, chunkKey, chunkKeyToCoords, type World } from "@voxyl/core";
import { now } from "./clock.ts";
import { Queue } from "./queue.ts";

// Light per cell is 16 bits: sky << 12 | red << 8 | green << 4 | blue, each 0..15.
export const SKY_SHIFT = 12;
export const FULL_SKY = 15 << SKY_SHIFT;
/**
 * What copyPadded() writes for light-blocking cells when asked to mark them. Real light only
 * reaches this value inside a see-through emitter of full white light under open sky, which
 * then reads as opaque: harmless, since faces are always lit from empty cells.
 */
export const OPAQUE_LIGHT = 0xffff;
const BLOCK_SHIFTS = [8, 4, 0] as const;
const NO_TOP = -0x80000000;
/** Light is stored in bricks of 2^BRICK_BITS cells a side (or whole chunks, if smaller). */
const BRICK_BITS = 3;

const DX = [1, -1, 0, 0, 0, 0] as const;
const DY = [0, 0, 1, -1, 0, 0] as const;
const DZ = [0, 0, 0, 0, 1, -1] as const;

/** What the engine needs to know about each cell state, indexed by state id (0 = empty). */
export interface LightMaterials {
  /** Nonzero if the state blocks light. */
  readonly opaque: Uint8Array;
  /** Emitted light, red << 8 | green << 4 | blue, each 0..15; 0 for none. */
  readonly emission: Uint16Array;
}

const channel = (value: number, shift: number) => (value >> shift) & 15;
const withChannel = (value: number, shift: number, level: number) =>
  (value & ~(15 << shift)) | (level << shift);

/**
 * Minecraft-style flood-fill light over a World: sky light from per-column heightmaps and
 * colored block light from emitters, both losing one level per cell. Light is derived data:
 * it is computed from the cells and the materials, never saved.
 *
 * Storage follows content. Each column keeps the height of its highest light-blocking cell;
 * cells above it are full sky light and cells below it dark, without being stored. Light is
 * stored in 8³ bricks, and a brick exists only once some cell in it differs from that
 * default (about a sixth of the bricks in a city). Edits relight incrementally with the
 * two-queue method (remove what the changed cells used to light, then refill), so cost
 * follows the size of the change, not the world.
 */
export class LightEngine {
  readonly #world: World;
  #materials: LightMaterials;
  readonly #bits: number;
  readonly #size: number;
  readonly #mask: number;
  readonly #volume: number;
  readonly #brickBits: number;
  readonly #brickMask: number;
  /** Per chunk, its light bricks; a missing brick (or chunk) holds the default light. */
  readonly #light = new Map<number, (Uint16Array | undefined)[]>();
  #brickCount = 0;
  readonly #opaque = new Map<number, Uint32Array>();
  readonly #tops = new Map<number, Int32Array>();
  readonly #dirty = new Set<number>();
  #lastDirty = Number.NaN;
  /**
   * One row below the lowest cell: the bottom of the lit world, like Minecraft's. Nothing
   * below it is stored or visited, which keeps open columns from lighting downward forever.
   */
  #floor = -1;
  readonly #queue = new Queue();
  readonly #removal = new Queue();

  // The chunk the last access touched, so neighbouring accesses skip the map lookups.
  #cx = Number.NaN;
  #cy = Number.NaN;
  #cz = Number.NaN;
  #cLight: (Uint16Array | undefined)[] | undefined;
  #cOpaque: Uint32Array | undefined;
  #cTop: Int32Array | undefined;

  constructor(world: World, materials: LightMaterials) {
    this.#world = world;
    this.#materials = materials;
    const L = world.layout;
    this.#bits = L.bits;
    this.#size = L.size;
    this.#mask = L.mask;
    this.#volume = L.volume;
    this.#brickBits = Math.min(BRICK_BITS, L.bits);
    this.#brickMask = (1 << this.#brickBits) - 1;
  }

  /** Replaces the materials. Call computeAll() afterwards. */
  setMaterials(materials: LightMaterials): void {
    this.#materials = materials;
  }

  /** Bytes held by light bricks (and their tables), opacity bits and heightmaps. */
  get memoryBytes(): number {
    let bytes = 0;
    for (const bricks of this.#light.values()) {
      bytes += bricks.length * 8;
      for (const brick of bricks) bytes += brick?.byteLength ?? 0;
    }
    for (const a of this.#opaque.values()) bytes += a.byteLength;
    for (const a of this.#tops.values()) bytes += a.byteLength;
    return bytes;
  }

  /** Light bricks stored (the rest hold their default light). */
  get lightBrickCount(): number {
    return this.#brickCount;
  }

  /** Packed light at a cell. */
  get(x: number, y: number, z: number): number {
    return this.#lightAt(x, y, z);
  }

  /** Lights the whole world from scratch. */
  computeAll(): void {
    this.#light.clear();
    this.#brickCount = 0;
    this.#opaque.clear();
    this.#tops.clear();
    this.#invalidate();
    const { opaque, emission } = this.#materials;
    const S = this.#size;
    const b = this.#bits;
    const m = this.#mask;
    const emitters: number[] = [];
    let minY = Number.POSITIVE_INFINITY;
    let start = now();
    // One pass per chunk: opacity bits, column heights, emitters.
    for (const key of this.#world.chunkKeys()) {
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const chunk = this.#world.chunk(cx, cy, cz);
      if (!chunk) continue;
      const bits = new Uint32Array(this.#volume >> 5);
      const tops = this.#topsFor(cx * S, cz * S, true) ?? new Int32Array(S * S);
      const oy = cy * S;
      let any = false;
      chunk.forEachOccupied((i, id) => {
        const y = oy + (i >> (2 * b));
        if (y < minY) minY = y;
        if (opaque[id]) {
          any = true;
          bits[i >> 5] = (bits[i >> 5] ?? 0) | (1 << (i & 31));
          const column = (i & m) + (((i >> b) & m) << b);
          if (y > (tops[column] ?? NO_TOP)) tops[column] = y;
        }
        const e = emission[id] ?? 0;
        if (e) emitters.push(cx * S + (i & m), y, cz * S + ((i >> b) & m), e);
      });
      if (any) this.#opaque.set(key, bits);
    }
    this.#floor = (Number.isFinite(minY) ? minY : 0) - 1;
    this.#invalidate();
    const scanMs = now() - start;
    start = now();

    // Sky: every open cell beside an exposed column, below its own column's top, starts at 14.
    const queue = this.#queue;
    queue.clear();
    for (const [key, tops] of this.#tops) {
      const [cx, , cz] = chunkKeyToCoords(key);
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const top = tops[lx + lz * S] ?? NO_TOP;
          if (top === NO_TOP) continue;
          const x = cx * S + lx;
          const z = cz * S + lz;
          for (let d = 0; d < 4; d++) {
            const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
            const nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0);
            const neighborTop = this.#topAt(nx, nz);
            if (neighborTop >= top) continue;
            for (let y = Math.max(neighborTop + 1, this.#floor); y < top; y++) {
              if (this.#isOpaque(x, y, z)) continue;
              const value = this.#lightAt(x, y, z);
              if (channel(value, SKY_SHIFT) < 14) {
                this.#setLight(x, y, z, withChannel(value, SKY_SHIFT, 14));
                queue.push(x, y, z, 0);
              }
            }
          }
        }
      }
    }
    this.#spread(SKY_SHIFT, queue);
    const skyMs = now() - start;
    start = now();

    // Block light, one channel at a time.
    for (const shift of BLOCK_SHIFTS) {
      queue.clear();
      for (let i = 0; i < emitters.length; i += 4) {
        const x = emitters[i] ?? 0;
        const y = emitters[i + 1] ?? 0;
        const z = emitters[i + 2] ?? 0;
        const level = channel(emitters[i + 3] ?? 0, shift);
        if (level === 0) continue;
        const value = this.#lightAt(x, y, z);
        if (channel(value, shift) < level)
          this.#setLight(x, y, z, withChannel(value, shift, level));
        queue.push(x, y, z, 0);
      }
      this.#spread(shift, queue);
    }
    this.lastTimings = { scanMs, skyMs, blockMs: now() - start };

    for (const key of this.#world.chunkKeys()) this.#dirty.add(key);
  }

  /** How long the phases of the last computeAll() took. */
  lastTimings = { scanMs: 0, skyMs: 0, blockMs: 0 };

  /**
   * Relights after edits, given the boxes the World recorded (World.recordChanges). Call it
   * after the edits are in the World and before reading light.
   */
  update(changes: readonly ChangedBox[]): void {
    if (changes.length === 0) return;
    const { opaque, emission } = this.#materials;
    const world = this.#world;

    // 1. Before touching anything: the old light of every changed cell, and which columns
    //    change height. Reading light now still uses the old heightmap, so defaults are right.
    const cells: number[] = []; // x, y, z, old light, new id
    const spans = new Map<string, [x: number, z: number, y0: number, y1: number]>();
    let lowest = Number.POSITIVE_INFINITY;
    for (const box of changes) {
      for (let y = box.y0; y <= box.y1; y++) {
        for (let z = box.z0; z <= box.z1; z++) {
          for (let x = box.x0; x <= box.x1; x++) {
            const id = world.getId(x, y, z);
            if (id !== 0 && y < lowest) lowest = y;
            cells.push(x, y, z, this.#lightAt(x, y, z), id);
          }
        }
      }
      // Every column the box touches, with the rows any edit changed in it.
      for (let z = box.z0; z <= box.z1; z++) {
        for (let x = box.x0; x <= box.x1; x++) {
          const tag = `${x},${z}`;
          const span = spans.get(tag);
          if (span) {
            span[2] = Math.min(span[2], box.y0);
            span[3] = Math.max(span[3], box.y1);
          } else {
            spans.set(tag, [x, z, box.y0, box.y1]);
          }
        }
      }
    }
    // Building at or below the floor would light rows never lit before: start over (rare).
    if (lowest <= this.#floor) {
      this.computeAll();
      return;
    }
    const floor = this.#floor;
    const columns: number[] = []; // x, z, old top, new top
    for (const [x, z, y0, y1] of spans.values()) {
      const oldTop = this.#topAt(x, z);
      const newTop = this.#newTop(x, z, oldTop, y0, y1);
      if (newTop !== oldTop) columns.push(x, z, oldTop, newTop);
    }
    // Column cells between the old and new tops change exposure: remember their old sky light.
    const covered: number[] = []; // x, y, z, old sky
    const uncovered: number[] = []; // x, y, z
    for (let i = 0; i < columns.length; i += 4) {
      const x = columns[i] ?? 0;
      const z = columns[i + 1] ?? 0;
      const oldTop = columns[i + 2] ?? 0;
      const newTop = columns[i + 3] ?? 0;
      if (newTop > oldTop) {
        for (let y = Math.max(floor, oldTop + 1); y < newTop; y++)
          covered.push(x, y, z, channel(this.#lightAt(x, y, z), SKY_SHIFT));
      } else {
        for (let y = Math.max(floor, newTop + 1); y <= oldTop; y++) uncovered.push(x, y, z);
      }
    }
    // Pin the old light of every cell whose default is about to change, by giving it a brick.
    for (let i = 0; i < covered.length; i += 4)
      this.#ensureBrick(covered[i] ?? 0, covered[i + 1] ?? 0, covered[i + 2] ?? 0);
    for (let i = 0; i < uncovered.length; i += 3)
      this.#ensureBrick(uncovered[i] ?? 0, uncovered[i + 1] ?? 0, uncovered[i + 2] ?? 0);

    // 2. Apply the new opacity and heights.
    for (let i = 0; i < cells.length; i += 5) {
      this.#setOpaqueBit(
        cells[i] ?? 0,
        cells[i + 1] ?? 0,
        cells[i + 2] ?? 0,
        (opaque[cells[i + 4] ?? 0] ?? 0) !== 0,
      );
    }
    for (let i = 0; i < columns.length; i += 4) {
      const x = columns[i] ?? 0;
      const z = columns[i + 1] ?? 0;
      const tops = this.#topsFor(x, z, true);
      if (tops) tops[(x & this.#mask) + (z & this.#mask) * this.#size] = columns[i + 3] ?? NO_TOP;
    }
    this.#invalidate();

    // 3. Sky: take away what changed cells and newly covered cells used to give, then refill.
    const removal = this.#removal;
    const refill = this.#queue;
    removal.clear();
    refill.clear();
    for (let i = 0; i < covered.length; i += 4) {
      const x = covered[i] ?? 0;
      const y = covered[i + 1] ?? 0;
      const z = covered[i + 2] ?? 0;
      const old = covered[i + 3] ?? 0;
      if (old > 0) {
        this.#setLight(x, y, z, withChannel(this.#lightAt(x, y, z), SKY_SHIFT, 0));
        removal.push(x, y, z, old);
      }
    }
    for (let i = 0; i < cells.length; i += 5) {
      const x = cells[i] ?? 0;
      const y = cells[i + 1] ?? 0;
      const z = cells[i + 2] ?? 0;
      const old = channel(cells[i + 3] ?? 0, SKY_SHIFT);
      if (old > 0 && !this.#isExposed(x, y, z)) {
        this.#setLight(x, y, z, withChannel(this.#lightAt(x, y, z), SKY_SHIFT, 0));
        removal.push(x, y, z, old);
      }
    }
    this.#unspread(SKY_SHIFT, removal, refill, null);
    for (let i = 0; i < uncovered.length; i += 3) {
      const x = uncovered[i] ?? 0;
      const y = uncovered[i + 1] ?? 0;
      const z = uncovered[i + 2] ?? 0;
      if (this.#isOpaque(x, y, z)) continue;
      this.#setLight(x, y, z, withChannel(this.#lightAt(x, y, z), SKY_SHIFT, 15));
      refill.push(x, y, z, 0);
    }
    this.#refillAround(cells, refill);
    this.#spread(SKY_SHIFT, refill);

    // 4. Block light, per channel: the same, with changed emitters as new sources.
    for (const shift of BLOCK_SHIFTS) {
      removal.clear();
      refill.clear();
      for (let i = 0; i < cells.length; i += 5) {
        const x = cells[i] ?? 0;
        const y = cells[i + 1] ?? 0;
        const z = cells[i + 2] ?? 0;
        const old = channel(cells[i + 3] ?? 0, shift);
        if (old > 0) {
          this.#setLight(x, y, z, withChannel(this.#lightAt(x, y, z), shift, 0));
          removal.push(x, y, z, old);
        }
      }
      const reseed: number[] = [];
      this.#unspread(shift, removal, refill, reseed);
      for (let i = 0; i < cells.length; i += 5) {
        const level = channel(emission[cells[i + 4] ?? 0] ?? 0, shift);
        if (level > 0) reseed.push(cells[i] ?? 0, cells[i + 1] ?? 0, cells[i + 2] ?? 0);
      }
      for (let i = 0; i < reseed.length; i += 3) {
        const x = reseed[i] ?? 0;
        const y = reseed[i + 1] ?? 0;
        const z = reseed[i + 2] ?? 0;
        const level = channel(emission[world.getId(x, y, z)] ?? 0, shift);
        const value = this.#lightAt(x, y, z);
        if (channel(value, shift) < level)
          this.#setLight(x, y, z, withChannel(value, shift, level));
        refill.push(x, y, z, 0);
      }
      this.#refillAround(cells, refill);
      this.#spread(shift, refill);
    }

    // 5. Ambient occlusion and face culling read neighbouring cells: remesh around every change.
    for (let i = 0; i < cells.length; i += 5)
      this.#markDirty(cells[i] ?? 0, cells[i + 1] ?? 0, cells[i + 2] ?? 0);
  }

  /** Keys of chunks whose meshes are stale because light or occlusion around them changed. */
  takeDirtyChunks(): number[] {
    const keys = [...this.#dirty];
    this.#dirty.clear();
    this.#lastDirty = Number.NaN;
    return keys;
  }

  /**
   * Writes the light of chunk [cx, cy, cz] plus a one-cell border into `out`, in the padded
   * layout World.copyPadded() uses. With `markOpaque`, light-blocking cells read OPAQUE_LIGHT
   * instead of their light, so one array carries both light and occlusion (for the GPU).
   */
  copyPadded(
    cx: number,
    cy: number,
    cz: number,
    out: Uint16Array,
    markOpaque = false,
  ): Uint16Array {
    const S = this.#size;
    // The padded box is 27 regions, each inside one chunk: the chunk itself, 6 faces, 12 edges
    // and 8 corners from its neighbours. Copying region by region looks each chunk up once.
    const from = (d: number) => (d < 0 ? 0 : d > 0 ? S + 1 : 1);
    const to = (d: number) => (d < 0 ? 0 : d > 0 ? S + 1 : S);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          this.#copyRegion(
            out,
            [cx * S - 1, cy * S - 1, cz * S - 1],
            [from(dx), from(dy), from(dz)],
            [to(dx), to(dy), to(dz)],
            markOpaque,
          );
        }
      }
    }
    return out;
  }

  /**
   * Copies padded cells p0..p1 (inclusive, all inside one chunk) of a box whose padded cell
   * [0, 0, 0] is at world `origin`.
   */
  #copyRegion(
    out: Uint16Array,
    origin: readonly [number, number, number],
    p0: readonly [number, number, number],
    p1: readonly [number, number, number],
    markOpaque: boolean,
  ): void {
    const S = this.#size;
    const P = S + 2;
    const b = this.#bits;
    const m = this.#mask;
    const [ox, oy, oz] = origin;
    const [px0, py0, pz0] = p0;
    const [px1, py1, pz1] = p1;
    const n = px1 - px0 + 1;
    this.#select(ox + px0, oy + py0, oz + pz0);
    const bricks = this.#cLight;
    const tops = this.#cTop;
    const opaque = markOpaque ? this.#cOpaque : undefined;
    const bb = this.#brickBits;
    const bm = this.#brickMask;
    const nb = b - bb;
    const lx0 = (ox + px0) & m;
    for (let py = py0; py <= py1; py++) {
      const y = oy + py;
      for (let pz = pz0; pz <= pz1; pz++) {
        const z = oz + pz;
        const o = px0 + pz * P + py * P * P;
        if (y < this.#floor) {
          out.fill(0, o, o + n); // nothing lives or is lit below the floor
          continue;
        }
        const i0 = lx0 + ((z & m) << b) + ((y & m) << (2 * b));
        // Light, one brick-wide run at a time: stored bricks are copied, the rest are default.
        const rowBrick = (((z & m) >> bb) << nb) + (((y & m) >> bb) << (2 * nb));
        const inRow = ((z & bm) << bb) + ((y & bm) << (2 * bb));
        for (let k = 0; k < n; ) {
          const lx = lx0 + k;
          const run = Math.min(n - k, (1 << bb) - (lx & bm));
          const brick = bricks?.[(lx >> bb) + rowBrick];
          if (brick) {
            const i = (lx & bm) + inRow;
            out.set(brick.subarray(i, i + run), o + k);
          } else {
            const column = lx + ((z & m) << b);
            for (let j = 0; j < run; j++) {
              out[o + k + j] = y > (tops ? (tops[column + j] ?? NO_TOP) : NO_TOP) ? FULL_SKY : 0;
            }
          }
          k += run;
        }
        // Opacity, 32 cells per word: skip empty words and fill solid ones whole.
        for (let k = 0; opaque && k < n; ) {
          const i = i0 + k;
          const word = opaque[i >> 5] ?? 0;
          const bit = i & 31;
          if (word === 0) {
            k += 32 - bit;
          } else if (word === 0xffffffff && bit === 0 && k + 32 <= n) {
            out.fill(OPAQUE_LIGHT, o + k, o + k + 32);
            k += 32;
          } else {
            if ((word & (1 << bit)) !== 0) out[o + k] = OPAQUE_LIGHT;
            k++;
          }
        }
      }
    }
  }

  // --- Propagation ---------------------------------------------------------------------

  /** Spreads one channel outward from every queued cell, one level lost per step. */
  #spread(shift: number, queue: Queue): void {
    const sky = shift === SKY_SHIFT;
    while (queue.size > 0) {
      queue.pop();
      const x = queue.x;
      const y = queue.y;
      const z = queue.z;
      const level = channel(this.#lightAt(x, y, z), shift);
      if (level <= 1) continue;
      for (let d = 0; d < 6; d++) {
        const nx = x + (DX[d] ?? 0);
        const ny = y + (DY[d] ?? 0);
        const nz = z + (DZ[d] ?? 0);
        if (ny < this.#floor || this.#isOpaque(nx, ny, nz)) continue;
        if (sky && ny > this.#cTopAt(nx, nz)) continue; // open sky is already full
        const value = this.#lightAt(nx, ny, nz);
        if (channel(value, shift) < level - 1) {
          this.#setLight(nx, ny, nz, withChannel(value, shift, level - 1));
          queue.push(nx, ny, nz, 0);
        }
      }
    }
  }

  /**
   * Removes light that came from the queued cells (each with the level it used to have).
   * Neighbours lit at least as brightly from elsewhere go to `refill` to spread back in.
   * Block-light emitters met along the way are cleared and collected in `reseed`.
   */
  #unspread(shift: number, removal: Queue, refill: Queue, reseed: number[] | null): void {
    const sky = shift === SKY_SHIFT;
    const { emission } = this.#materials;
    while (removal.size > 0) {
      removal.pop();
      const x = removal.x;
      const y = removal.y;
      const z = removal.z;
      const level = removal.v;
      for (let d = 0; d < 6; d++) {
        const nx = x + (DX[d] ?? 0);
        const ny = y + (DY[d] ?? 0);
        const nz = z + (DZ[d] ?? 0);
        if (ny < this.#floor) continue;
        if (sky && ny > this.#cTopAt(nx, nz)) {
          refill.push(nx, ny, nz, 0);
          continue;
        }
        const value = this.#lightAt(nx, ny, nz);
        const neighbor = channel(value, shift);
        if (neighbor === 0) continue;
        if (neighbor < level) {
          this.#setLight(nx, ny, nz, withChannel(value, shift, 0));
          removal.push(nx, ny, nz, neighbor);
          if (reseed && (emission[this.#world.getId(nx, ny, nz)] ?? 0) !== 0)
            reseed.push(nx, ny, nz);
        } else {
          refill.push(nx, ny, nz, 0);
        }
      }
    }
  }

  /** Queues the neighbours of changed open cells, so light flows back into them. */
  #refillAround(cells: number[], refill: Queue): void {
    const { opaque } = this.#materials;
    for (let i = 0; i < cells.length; i += 5) {
      if ((opaque[cells[i + 4] ?? 0] ?? 0) !== 0) continue;
      const x = cells[i] ?? 0;
      const y = cells[i + 1] ?? 0;
      const z = cells[i + 2] ?? 0;
      for (let d = 0; d < 6; d++)
        refill.push(x + (DX[d] ?? 0), y + (DY[d] ?? 0), z + (DZ[d] ?? 0), 0);
    }
  }

  /** The highest light-blocking cell of column [x, z] after an edit to box rows y0..y1. */
  #newTop(x: number, z: number, oldTop: number, y0: number, y1: number): number {
    if (oldTop > y1) return oldTop;
    const { opaque } = this.#materials;
    for (let y = y1; y >= y0; y--) {
      if ((opaque[this.#world.getId(x, y, z)] ?? 0) !== 0) return y;
    }
    if (oldTop < y0) return oldTop;
    // The old top was inside the box and is gone: look further down.
    for (let y = y0 - 1; y > this.#floor; y--) {
      if ((opaque[this.#world.getId(x, y, z)] ?? 0) !== 0) return y;
    }
    return NO_TOP;
  }

  // --- Storage -------------------------------------------------------------------------

  #invalidate(): void {
    this.#cx = Number.NaN;
  }

  /** Points the access cache at the chunk holding [x, y, z] and returns the local index. */
  #select(x: number, y: number, z: number): number {
    const b = this.#bits;
    const cx = x >> b;
    const cy = y >> b;
    const cz = z >> b;
    if (cx !== this.#cx || cy !== this.#cy || cz !== this.#cz) {
      this.#cx = cx;
      this.#cy = cy;
      this.#cz = cz;
      const key = chunkKey(cx, cy, cz);
      this.#cLight = this.#light.get(key);
      this.#cOpaque = this.#opaque.get(key);
      this.#cTop = this.#tops.get(chunkKey(cx, 0, cz));
    }
    const m = this.#mask;
    return (x & m) + ((z & m) << b) + ((y & m) << (2 * b));
  }

  /** Index of the brick holding [x, y, z] within its chunk. */
  #brickOf(x: number, y: number, z: number): number {
    const m = this.#mask;
    const bb = this.#brickBits;
    const nb = this.#bits - bb;
    return ((x & m) >> bb) + (((z & m) >> bb) << nb) + (((y & m) >> bb) << (2 * nb));
  }

  /** Index of [x, y, z] within its brick. */
  #inBrick(x: number, y: number, z: number): number {
    const bm = this.#brickMask;
    const bb = this.#brickBits;
    return (x & bm) + ((z & bm) << bb) + ((y & bm) << (2 * bb));
  }

  /**
   * Light where no brick is stored: open sky above the column's highest light-blocking cell,
   * dark below. Needs #select() on the cell first, and y at or above the floor.
   */
  #defaultAt(x: number, y: number, z: number): number {
    const tops = this.#cTop;
    const top = tops
      ? (tops[(x & this.#mask) + ((z & this.#mask) << this.#bits)] ?? NO_TOP)
      : NO_TOP;
    return y > top ? FULL_SKY : 0;
  }

  #lightAt(x: number, y: number, z: number): number {
    if (y < this.#floor) return 0;
    this.#select(x, y, z);
    const brick = this.#cLight?.[this.#brickOf(x, y, z)];
    return brick ? (brick[this.#inBrick(x, y, z)] ?? 0) : this.#defaultAt(x, y, z);
  }

  #setLight(x: number, y: number, z: number, value: number): void {
    if (y < this.#floor) return;
    this.#select(x, y, z);
    const b = this.#brickOf(x, y, z);
    let brick = this.#cLight?.[b];
    if (!brick) {
      if (value === this.#defaultAt(x, y, z)) return; // still the default: nothing to store
      brick = this.#allocateBrick(b);
    }
    const i = this.#inBrick(x, y, z);
    if (brick[i] === value) return;
    brick[i] = value;
    this.#markDirty(x, y, z);
  }

  /** Gives brick `b` of the selected chunk an array filled with its default light. */
  #allocateBrick(b: number): Uint16Array {
    const S = this.#size;
    const bb = this.#brickBits;
    const B = 1 << bb;
    const nb = this.#bits - bb;
    const per = (1 << nb) - 1;
    const bx = (b & per) << bb;
    const bz = ((b >> nb) & per) << bb;
    const oy = this.#cy * S + ((b >> (2 * nb)) << bb);
    const brick = new Uint16Array(B * B * B);
    const tops = this.#cTop;
    for (let z = 0; z < B; z++) {
      for (let x = 0; x < B; x++) {
        const top = tops ? (tops[bx + x + (bz + z) * S] ?? NO_TOP) : NO_TOP;
        for (let y = 0; y < B; y++) {
          const wy = oy + y;
          if (wy > top && wy >= this.#floor) brick[x + (z << bb) + (y << (2 * bb))] = FULL_SKY;
        }
      }
    }
    let bricks = this.#cLight;
    if (!bricks) {
      bricks = new Array<Uint16Array | undefined>(1 << (3 * nb));
      this.#light.set(chunkKey(this.#cx, this.#cy, this.#cz), bricks);
      this.#cLight = bricks;
    }
    bricks[b] = brick;
    this.#brickCount++;
    return brick;
  }

  #ensureBrick(x: number, y: number, z: number): void {
    this.#select(x, y, z);
    const b = this.#brickOf(x, y, z);
    if (!this.#cLight?.[b]) this.#allocateBrick(b);
  }

  #isOpaque(x: number, y: number, z: number): boolean {
    const i = this.#select(x, y, z);
    const bits = this.#cOpaque;
    return bits ? ((bits[i >> 5] ?? 0) & (1 << (i & 31))) !== 0 : false;
  }

  #isExposed(x: number, y: number, z: number): boolean {
    return y > this.#topAt(x, z);
  }

  #setOpaqueBit(x: number, y: number, z: number, on: boolean): void {
    const b = this.#bits;
    const key = chunkKey(x >> b, y >> b, z >> b);
    let bits = this.#opaque.get(key);
    if (!bits) {
      if (!on) return;
      bits = new Uint32Array(this.#volume >> 5);
      this.#opaque.set(key, bits);
      this.#invalidate();
    }
    const m = this.#mask;
    const i = (x & m) + ((z & m) << b) + ((y & m) << (2 * b));
    if (on) bits[i >> 5] = (bits[i >> 5] ?? 0) | (1 << (i & 31));
    else bits[i >> 5] = (bits[i >> 5] ?? 0) & ~(1 << (i & 31));
  }

  #topsFor(x: number, z: number, create: boolean): Int32Array | undefined {
    const b = this.#bits;
    const key = chunkKey(x >> b, 0, z >> b);
    let tops = this.#tops.get(key);
    if (!tops && create) {
      tops = new Int32Array(this.#size * this.#size).fill(NO_TOP);
      this.#tops.set(key, tops);
      this.#invalidate();
    }
    return tops;
  }

  #topAt(x: number, z: number): number {
    const tops = this.#topsFor(x, z, false);
    return tops ? (tops[(x & this.#mask) + ((z & this.#mask) << this.#bits)] ?? NO_TOP) : NO_TOP;
  }

  /** Column height through the access cache when [x, z] is in the selected chunk's column. */
  #cTopAt(x: number, z: number): number {
    const b = this.#bits;
    if (x >> b === this.#cx && z >> b === this.#cz) {
      const tops = this.#cTop;
      return tops ? (tops[(x & this.#mask) + ((z & this.#mask) << b)] ?? NO_TOP) : NO_TOP;
    }
    return this.#topAt(x, z);
  }

  /** Marks the chunk holding [x, y, z], and any chunk whose padded border includes it. */
  #markDirty(x: number, y: number, z: number): void {
    const b = this.#bits;
    const last = this.#size - 1;
    const cx = x >> b;
    const cy = y >> b;
    const cz = z >> b;
    const lx = x & this.#mask;
    const ly = y & this.#mask;
    const lz = z & this.#mask;
    if (lx !== 0 && lx !== last && ly !== 0 && ly !== last && lz !== 0 && lz !== last) {
      // The common case, and called on every light write: skip repeats of the same chunk.
      const key = chunkKey(cx, cy, cz);
      if (key !== this.#lastDirty) {
        this.#dirty.add(key);
        this.#lastDirty = key;
      }
      return;
    }
    const x0 = lx === 0 ? -1 : 0;
    const x1 = lx === last ? 1 : 0;
    const y0 = ly === 0 ? -1 : 0;
    const y1 = ly === last ? 1 : 0;
    const z0 = lz === 0 ? -1 : 0;
    const z1 = lz === last ? 1 : 0;
    for (let dy = y0; dy <= y1; dy++) {
      for (let dz = z0; dz <= z1; dz++) {
        for (let dx = x0; dx <= x1; dx++) this.#dirty.add(chunkKey(cx + dx, cy + dy, cz + dz));
      }
    }
  }
}
