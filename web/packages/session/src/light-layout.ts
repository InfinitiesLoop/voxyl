import { chunkKey, chunkKeyToCoords } from "@voxyl/core";

/** Cells per brick side on the GPU is 2^brickBits; see LightEngine's GPU_BRICK_BITS. */
export interface LightLayoutOptions {
  readonly chunkBits: number;
  readonly brickBits: number;
}

/**
 * GPU writes for the light volume, in order: bricks, then tables, then the grid, so nothing
 * points at light that isn't there yet. The renderer applies a whole update in one frame.
 */
export interface LightLayoutUpdate {
  /** Pool slots in use, counting freed ones: grow the pool (keeping what it holds) to fit. */
  readonly poolBricks: number;
  /** Chunk tables in use likewise. */
  readonly tableCount: number;
  /** Pool slot of each brick written, ascending. */
  readonly slots: Uint32Array;
  /** Their light, brickVolume cells each, indexed x + z * B + y * B * B (OPAQUE_LIGHT marks). */
  readonly bricks: Uint16Array;
  /** Tables rewritten whole: their indices, and tableLength entries each (slot + 1, or 0). */
  readonly tables: Uint32Array;
  readonly tableData: Uint32Array;
  /** The chunk grid, if it changed: chunk coordinates covered, and table + 1 per chunk (or 0). */
  readonly grid: {
    readonly origin: readonly [number, number, number];
    readonly size: readonly [number, number, number];
    /** Indexed x + z * sx + y * sx * sz. */
    readonly data: Uint32Array;
  } | null;
}

interface ChunkTable {
  readonly index: number;
  /** Slot + 1 per local brick, as the GPU should see it: 0 until the brick's light is sent. */
  readonly entries: Uint32Array;
  /** Pool slot per local brick, -1 if none. */
  readonly slots: Int32Array;
  /** How many meshes read each local brick. */
  readonly users: Uint16Array;
  usedBricks: number;
}

/** Copies a box of light (with light-blocking cells marked) into `out`. */
export type CopyLight = (
  origin: readonly [number, number, number],
  size: readonly [number, number, number],
  out: Uint16Array,
) => void;

const GRID_MARGIN = 2;

/**
 * Where light lives on the GPU. Faces read light from the empty cell in front of them and its
 * neighbours (see ChunkMesh.lightBricks), which is a small part of the world: only bricks
 * that some mesh reads are kept, in a pool. A chunk's table maps its local bricks to pool
 * slots, and a grid over chunk coordinates maps chunks to tables. The renderer reads a cell's
 * light as grid -> table -> pool, and treats a missing brick as open sky.
 *
 * Everything is decided here, in the world worker; the renderer only copies what
 * takeUpdate() returns into its textures.
 */
export class LightLayout {
  readonly brickBits: number;
  /** Cells per brick. */
  readonly brickVolume: number;
  /** Entries per chunk table: bricks per chunk. */
  readonly tableLength: number;
  readonly #chunkBits: number;
  /** Bricks per chunk side. */
  readonly #n: number;
  readonly #tables = new Map<number, ChunkTable>();
  readonly #meshBricks = new Map<number, Uint16Array>();
  /** Bricks whose light should be sent: chunk key -> local bricks. */
  readonly #pending = new Map<number, Set<number>>();
  readonly #dirtyTables = new Set<number>();
  #gridDirty = true;
  #gridOrigin: [number, number, number] = [0, 0, 0];
  #gridSize: [number, number, number] = [0, 0, 0];
  readonly #freeSlots: number[] = [];
  #nextSlot = 0;
  readonly #freeTables: number[] = [];
  #nextTable = 0;

  constructor(options: LightLayoutOptions) {
    this.#chunkBits = options.chunkBits;
    this.brickBits = Math.min(options.brickBits, options.chunkBits);
    this.#n = 1 << (this.#chunkBits - this.brickBits);
    this.brickVolume = 1 << (3 * this.brickBits);
    this.tableLength = this.#n ** 3;
  }

  /** Bricks kept on the GPU. */
  get brickCount(): number {
    return this.#nextSlot - this.#freeSlots.length;
  }

  get tableCount(): number {
    return this.#tables.size;
  }

  /** True while light or tables are waiting to be sent. */
  get pending(): boolean {
    return this.#pending.size > 0 || this.#dirtyTables.size > 0 || this.#gridDirty;
  }

  /**
   * The bricks chunk `key`'s mesh reads (ChunkMesh.lightBricks), replacing its previous list;
   * an empty list forgets the chunk.
   */
  setMeshBricks(key: number, bricks: Uint16Array): void {
    const old = this.#meshBricks.get(key);
    if (bricks.length > 0) this.#meshBricks.set(key, bricks);
    else this.#meshBricks.delete(key);
    // Add the new uses before dropping the old, so bricks both share are never freed.
    this.#visit(key, bricks, (table, local) => this.#use(table, local));
    if (old) this.#visit(key, old, (table, local) => this.#release(table, local));
  }

  /** Light changed in these bricks (LightEngine.takeDirty()); `all` means everywhere. */
  markDirty(dirty: { all: boolean; bricks: ReadonlyMap<number, ReadonlySet<number>> }): void {
    if (dirty.all) {
      for (const [key, table] of this.#tables) {
        for (let local = 0; local < this.tableLength; local++) {
          if ((table.users[local] ?? 0) > 0) this.#queue(key, local);
        }
      }
      return;
    }
    for (const [key, locals] of dirty.bricks) {
      const table = this.#tables.get(key);
      if (!table) continue;
      for (const local of locals) if ((table.users[local] ?? 0) > 0) this.#queue(key, local);
    }
  }

  /**
   * The next batch of GPU writes, with the light of at most `maxBricks` bricks, or null if
   * nothing is waiting.
   */
  takeUpdate(copy: CopyLight, maxBricks: number): LightLayoutUpdate | null {
    if (!this.pending) return null;
    const B = 1 << this.brickBits;
    const n = this.#n;
    // Gather bricks, then send them in slot order so runs of slots are written together.
    const chosen: { key: number; local: number; slot: number }[] = [];
    for (const [key, locals] of this.#pending) {
      const table = this.#tables.get(key);
      for (const local of locals) {
        if (chosen.length >= maxBricks) break;
        locals.delete(local);
        const slot = table?.slots[local] ?? -1;
        if (slot >= 0) chosen.push({ key, local, slot });
      }
      if (locals.size === 0) this.#pending.delete(key);
      if (chosen.length >= maxBricks) break;
    }
    chosen.sort((a, b) => a.slot - b.slot);
    const slots = new Uint32Array(chosen.length);
    const bricks = new Uint16Array(chosen.length * this.brickVolume);
    chosen.forEach(({ key, local, slot }, i) => {
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const S = 1 << this.#chunkBits;
      const origin = [
        cx * S + (local % n) * B,
        cy * S + Math.floor(local / (n * n)) * B,
        cz * S + (Math.floor(local / n) % n) * B,
      ] as const;
      copy(origin, [B, B, B], bricks.subarray(i * this.brickVolume, (i + 1) * this.brickVolume));
      slots[i] = slot;
      // Now that its light is on the way, the table may point at it.
      const table = this.#tables.get(key);
      if (table && table.entries[local] !== slot + 1) {
        table.entries[local] = slot + 1;
        this.#dirtyTables.add(key);
      }
    });

    const tables = new Uint32Array(this.#dirtyTables.size);
    const tableData = new Uint32Array(this.#dirtyTables.size * this.tableLength);
    let t = 0;
    for (const key of this.#dirtyTables) {
      const table = this.#tables.get(key);
      if (!table) continue;
      tables[t] = table.index;
      tableData.set(table.entries, t * this.tableLength);
      t++;
    }
    this.#dirtyTables.clear();

    let grid: LightLayoutUpdate["grid"] = null;
    if (this.#gridDirty) {
      grid = this.#buildGrid();
      this.#gridDirty = false;
    }
    return {
      poolBricks: this.#nextSlot,
      tableCount: this.#nextTable,
      slots,
      bricks,
      tables: tables.subarray(0, t),
      tableData: tableData.subarray(0, t * this.tableLength),
      grid,
    };
  }

  /** Calls `visit` with the table and local brick of every brick in a mesh's list. */
  #visit(key: number, bricks: Uint16Array, visit: (chunk: number, local: number) => void): void {
    const n = this.#n;
    const NB = n + 2;
    const [cx, cy, cz] = chunkKeyToCoords(key);
    for (const b of bricks) {
      // Chunk-relative brick coordinates, -1..n: -1 and n belong to the neighbours.
      const bx = (b % NB) - 1;
      const bz = (Math.floor(b / NB) % NB) - 1;
      const by = Math.floor(b / (NB * NB)) - 1;
      const dx = bx < 0 ? -1 : bx >= n ? 1 : 0;
      const dy = by < 0 ? -1 : by >= n ? 1 : 0;
      const dz = bz < 0 ? -1 : bz >= n ? 1 : 0;
      const local = bx - dx * n + (bz - dz * n) * n + (by - dy * n) * n * n;
      visit(chunkKey(cx + dx, cy + dy, cz + dz), local);
    }
  }

  #use(key: number, local: number): void {
    let table = this.#tables.get(key);
    if (!table) {
      table = {
        index: this.#allocateTable(),
        entries: new Uint32Array(this.tableLength),
        slots: new Int32Array(this.tableLength).fill(-1),
        users: new Uint16Array(this.tableLength),
        usedBricks: 0,
      };
      this.#tables.set(key, table);
      this.#dirtyTables.add(key);
      this.#includeInGrid(key);
    }
    const users = table.users[local] ?? 0;
    table.users[local] = users + 1;
    if (users > 0) return;
    table.usedBricks++;
    table.slots[local] = this.#allocateSlot();
    this.#queue(key, local);
  }

  #release(key: number, local: number): void {
    const table = this.#tables.get(key);
    if (!table) return;
    const users = (table.users[local] ?? 0) - 1;
    table.users[local] = users;
    if (users > 0) return;
    const slot = table.slots[local] ?? -1;
    if (slot >= 0) this.#freeSlots.push(slot);
    table.slots[local] = -1;
    table.entries[local] = 0;
    table.usedBricks--;
    this.#pending.get(key)?.delete(local);
    this.#dirtyTables.add(key);
    if (table.usedBricks === 0) {
      // Nothing reads this chunk any more: its table goes back.
      this.#tables.delete(key);
      this.#dirtyTables.delete(key);
      this.#pending.delete(key);
      this.#freeTables.push(table.index);
      this.#gridDirty = true;
    }
  }

  #queue(key: number, local: number): void {
    let locals = this.#pending.get(key);
    if (!locals) {
      locals = new Set();
      this.#pending.set(key, locals);
    }
    locals.add(local);
  }

  #allocateSlot(): number {
    const free = this.#freeSlots.pop();
    if (free !== undefined) return free;
    const slot = this.#nextSlot++;
    return slot;
  }

  #allocateTable(): number {
    const free = this.#freeTables.pop();
    if (free !== undefined) return free;
    const index = this.#nextTable++;
    return index;
  }

  /** Grows the grid to cover chunk `key`, with a margin so it rarely grows again. */
  #includeInGrid(key: number): void {
    this.#gridDirty = true;
    const c = chunkKeyToCoords(key);
    const [ox, oy, oz] = this.#gridOrigin;
    const [sx, sy, sz] = this.#gridSize;
    const inside =
      sx > 0 &&
      c[0] >= ox &&
      c[0] < ox + sx &&
      c[1] >= oy &&
      c[1] < oy + sy &&
      c[2] >= oz &&
      c[2] < oz + sz;
    if (inside) return;
    const lo = [0, 1, 2].map((i) =>
      sx > 0
        ? Math.min(this.#gridOrigin[i] ?? 0, (c[i] ?? 0) - GRID_MARGIN)
        : (c[i] ?? 0) - GRID_MARGIN,
    );
    const hi = [0, 1, 2].map((i) =>
      sx > 0
        ? Math.max(
            (this.#gridOrigin[i] ?? 0) + (this.#gridSize[i] ?? 0),
            (c[i] ?? 0) + 1 + GRID_MARGIN,
          )
        : (c[i] ?? 0) + 1 + GRID_MARGIN,
    );
    this.#gridOrigin = [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0];
    this.#gridSize = [
      (hi[0] ?? 0) - (lo[0] ?? 0),
      (hi[1] ?? 0) - (lo[1] ?? 0),
      (hi[2] ?? 0) - (lo[2] ?? 0),
    ];
  }

  #buildGrid(): NonNullable<LightLayoutUpdate["grid"]> {
    const [ox, oy, oz] = this.#gridOrigin;
    const [sx, sy, sz] = this.#gridSize;
    const data = new Uint32Array(sx * sy * sz);
    for (const [key, table] of this.#tables) {
      const [cx, cy, cz] = chunkKeyToCoords(key);
      data[cx - ox + (cz - oz) * sx + (cy - oy) * sx * sz] = table.index + 1;
    }
    return { origin: [ox, oy, oz], size: [sx, sy, sz], data };
  }
}
