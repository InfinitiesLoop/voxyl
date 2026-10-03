import { type ChangedBox, chunkKey, chunkKeyToCoords, type World } from "@voxyl/core";
import { now } from "./clock.ts";
import { Queue } from "./queue.ts";

// Light per cell is 16 bits: sky << 12 | red << 8 | green << 4 | blue, each 0..15.
export const SKY_SHIFT = 12;
export const FULL_SKY = 15 << SKY_SHIFT;
const BLOCK_SHIFTS = [8, 4, 0] as const;
const NO_TOP = -0x80000000;

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
 * cells above it are full sky light without being stored. A chunk gets a light array only
 * once some cell in it differs from that default. Edits relight incrementally with the
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
  readonly #light = new Map<number, Uint16Array>();
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
  #cLight: Uint16Array | undefined;
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
  }

  /** Replaces the materials. Call computeAll() afterwards. */
  setMaterials(materials: LightMaterials): void {
    this.#materials = materials;
  }

  /** Bytes held by light arrays, opacity bits and heightmaps. */
  get memoryBytes(): number {
    let bytes = 0;
    for (const a of this.#light.values()) bytes += a.byteLength;
    for (const a of this.#opaque.values()) bytes += a.byteLength;
    for (const a of this.#tops.values()) bytes += a.byteLength;
    return bytes;
  }

  /** Chunks holding a light array (the rest are at their default). */
  get lightChunkCount(): number {
    return this.#light.size;
  }

  /** Packed light at a cell. */
  get(x: number, y: number, z: number): number {
    return this.#lightAt(x, y, z);
  }

  /** Lights the whole world from scratch. */
  computeAll(): void {
    this.#light.clear();
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
    // Pin the old light of every chunk whose defaults are about to change, by giving it an array.
    for (let i = 0; i < covered.length; i += 4)
      this.#ensureArray(covered[i] ?? 0, covered[i + 1] ?? 0, covered[i + 2] ?? 0);
    for (let i = 0; i < uncovered.length; i += 3)
      this.#ensureArray(uncovered[i] ?? 0, uncovered[i + 1] ?? 0, uncovered[i + 2] ?? 0);

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
   * layout World.copyPadded() uses, for the mesher.
   */
  copyPadded(cx: number, cy: number, cz: number, out: Uint16Array): Uint16Array {
    const S = this.#size;
    const P = S + 2;
    const ox = cx * S;
    const oy = cy * S;
    const oz = cz * S;
    for (let py = 0; py < P; py++) {
      for (let pz = 0; pz < P; pz++) {
        let o = pz * P + py * P * P;
        const y = oy + py - 1;
        const z = oz + pz - 1;
        const inside = py > 0 && py <= S && pz > 0 && pz <= S;
        if (inside) {
          out[o] = this.#lightAt(ox - 1, y, z);
          this.#select(ox, y, z);
          const light = this.#cLight;
          if (light) {
            const from = (z & this.#mask) * S + (y & this.#mask) * S * S;
            out.set(light.subarray(from, from + S), o + 1);
          } else {
            const tops = this.#cTop;
            for (let lx = 0; lx < S; lx++) {
              const top = tops ? (tops[lx + (z & this.#mask) * S] ?? NO_TOP) : NO_TOP;
              out[o + 1 + lx] = y > top && y >= this.#floor ? FULL_SKY : 0;
            }
          }
          out[o + S + 1] = this.#lightAt(ox + S, y, z);
          continue;
        }
        for (let px = 0; px < P; px++, o++) out[o] = this.#lightAt(ox + px - 1, y, z);
      }
    }
    return out;
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

  #lightAt(x: number, y: number, z: number): number {
    if (y < this.#floor) return 0;
    const i = this.#select(x, y, z);
    const light = this.#cLight;
    if (light) return light[i] ?? 0;
    const tops = this.#cTop;
    const top = tops
      ? (tops[(x & this.#mask) + ((z & this.#mask) << this.#bits)] ?? NO_TOP)
      : NO_TOP;
    return y > top ? FULL_SKY : 0;
  }

  #setLight(x: number, y: number, z: number, value: number): void {
    if (y < this.#floor) return;
    const i = this.#select(x, y, z);
    let light = this.#cLight;
    if (!light) light = this.#allocate();
    if (light[i] === value) return;
    light[i] = value;
    this.#markDirty(x, y, z);
  }

  /** Gives the selected chunk a light array filled with its default (sky above the heights). */
  #allocate(): Uint16Array {
    const S = this.#size;
    const light = new Uint16Array(this.#volume);
    const tops = this.#cTop;
    const oy = this.#cy * S;
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const top = tops ? (tops[lx + lz * S] ?? NO_TOP) : NO_TOP;
        for (let ly = 0; ly < S; ly++) {
          const y = oy + ly;
          if (y > top && y >= this.#floor) light[lx + lz * S + ly * S * S] = FULL_SKY;
        }
      }
    }
    this.#light.set(chunkKey(this.#cx, this.#cy, this.#cz), light);
    this.#cLight = light;
    return light;
  }

  #ensureArray(x: number, y: number, z: number): void {
    this.#select(x, y, z);
    if (!this.#cLight) this.#allocate();
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
