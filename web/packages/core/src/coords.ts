// World coordinates are integers and may be negative, as in the Godot app. The world is split
// into cubic chunks, the unit of storage, meshing, dirty tracking and sync. Chunk size is a
// per-world setting (ChunkLayout) so it can be tuned against real builds.

export const DEFAULT_CHUNK_BITS = 5;
export const MIN_CHUNK_BITS = 3;
/** 64-cell chunks at most: the mesher packs chunk-local coordinates and quad sizes into bytes. */
export const MAX_CHUNK_BITS = 6;

// Chunk keys pack three 17-bit chunk coordinates into one safe integer (51 bits), so the chunk
// map is keyed by numbers, not strings. Keys don't depend on chunk size.
const KEY_SPAN = 2 ** 17;
const KEY_OFFSET = 2 ** 16;
export const MIN_CHUNK_COORD = -KEY_OFFSET;
export const MAX_CHUNK_COORD = KEY_OFFSET - 1;

export function chunkKey(cx: number, cy: number, cz: number): number {
  return ((cx + KEY_OFFSET) * KEY_SPAN + (cy + KEY_OFFSET)) * KEY_SPAN + (cz + KEY_OFFSET);
}

export function chunkKeyToCoords(key: number): [cx: number, cy: number, cz: number] {
  const cz = (key % KEY_SPAN) - KEY_OFFSET;
  const rest = Math.floor(key / KEY_SPAN);
  const cy = (rest % KEY_SPAN) - KEY_OFFSET;
  const cx = Math.floor(rest / KEY_SPAN) - KEY_OFFSET;
  return [cx, cy, cz];
}

/** Chunk size and the coordinate math that depends on it. */
export class ChunkLayout {
  readonly bits: number;
  /** Cells along each edge of a chunk. */
  readonly size: number;
  readonly mask: number;
  /** Cells in a chunk. */
  readonly volume: number;
  /**
   * Index steps in a chunk's cell array. Y-major, so one horizontal layer of a chunk is a
   * contiguous run: index = x + z * size + y * size * size.
   */
  readonly strideX = 1;
  readonly strideZ: number;
  readonly strideY: number;
  readonly minWorld: number;
  readonly maxWorld: number;

  constructor(bits = DEFAULT_CHUNK_BITS) {
    if (!Number.isInteger(bits) || bits < MIN_CHUNK_BITS || bits > MAX_CHUNK_BITS) {
      throw new RangeError(
        `Chunk bits must be an integer from ${MIN_CHUNK_BITS} to ${MAX_CHUNK_BITS}`,
      );
    }
    this.bits = bits;
    this.size = 1 << bits;
    this.mask = this.size - 1;
    this.volume = this.size ** 3;
    this.strideZ = this.size;
    this.strideY = this.size * this.size;
    this.minWorld = MIN_CHUNK_COORD * this.size;
    this.maxWorld = (MAX_CHUNK_COORD + 1) * this.size - 1;
  }

  /** The chunk coordinate holding world coordinate `v` (floor division, so -1 is in chunk -1). */
  toChunk(v: number): number {
    return v >> this.bits;
  }

  /** Where world coordinate `v` sits inside its chunk. */
  toLocal(v: number): number {
    return v & this.mask;
  }

  localIndex(lx: number, ly: number, lz: number): number {
    return lx + lz * this.strideZ + ly * this.strideY;
  }

  isWorldCoord(v: number): boolean {
    return Number.isInteger(v) && v >= this.minWorld && v <= this.maxWorld;
  }

  assertWorldPos(x: number, y: number, z: number): void {
    if (!this.isWorldCoord(x) || !this.isWorldCoord(y) || !this.isWorldCoord(z)) {
      throw new RangeError(
        `Position [${x}, ${y}, ${z}] is outside the world (integers from ${this.minWorld} to ${this.maxWorld})`,
      );
    }
  }
}
