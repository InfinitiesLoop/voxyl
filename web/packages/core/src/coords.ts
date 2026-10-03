// World coordinates are integers and may be negative, as in the Godot app. The world is split
// into 32x32x32 chunks: the unit of storage, meshing, dirty tracking and sync.

export const CHUNK_BITS = 5;
export const CHUNK_SIZE = 1 << CHUNK_BITS;
export const CHUNK_MASK = CHUNK_SIZE - 1;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

// Chunk keys pack three 17-bit chunk coordinates into one safe integer (51 bits), so the chunk
// map is keyed by numbers, not strings. That bounds chunk coordinates to ±65,536, which puts
// world coordinates within ±2,097,152 cells on every axis.
const KEY_SPAN = 2 ** 17;
const KEY_OFFSET = 2 ** 16;
export const MIN_CHUNK_COORD = -KEY_OFFSET;
export const MAX_CHUNK_COORD = KEY_OFFSET - 1;
export const MIN_WORLD_COORD = MIN_CHUNK_COORD * CHUNK_SIZE;
export const MAX_WORLD_COORD = (MAX_CHUNK_COORD + 1) * CHUNK_SIZE - 1;

/** The chunk coordinate holding world coordinate `v` (floor division, so -1 is in chunk -1). */
export const toChunk = (v: number): number => v >> CHUNK_BITS;

/** Where world coordinate `v` sits inside its chunk, 0..31. */
export const toLocal = (v: number): number => v & CHUNK_MASK;

/**
 * Index of a local position in a chunk's cell array. Y-major, so one horizontal layer of a
 * chunk is a contiguous run (layer views and slices read it without striding).
 */
export const localIndex = (lx: number, ly: number, lz: number): number =>
  (ly << (2 * CHUNK_BITS)) | (lz << CHUNK_BITS) | lx;

export function isWorldCoord(v: number): boolean {
  return Number.isInteger(v) && v >= MIN_WORLD_COORD && v <= MAX_WORLD_COORD;
}

export function assertWorldPos(x: number, y: number, z: number): void {
  if (!isWorldCoord(x) || !isWorldCoord(y) || !isWorldCoord(z)) {
    throw new RangeError(
      `Position [${x}, ${y}, ${z}] is outside the world (integers from ${MIN_WORLD_COORD} to ${MAX_WORLD_COORD})`,
    );
  }
}

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
