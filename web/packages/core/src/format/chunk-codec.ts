// Storage chunks: the unit of saving and sync (web-core.md, section 8). A fixed 32³, whatever
// chunk size the world runs with, encoded as 8³ bricks that are empty, uniform, or bit-packed
// indices into the chunk's own palette of state ids. The encoded bytes are hashed for the
// chunk's name, then compressed.
//
//   u8 version (1)
//   varint n, then n varints: the chunk palette's state ids (local index 0 is always empty)
//   64 bricks, y-major then z then x, each:
//     u8 0 = empty | 1 = uniform, then varint local index | 2 = packed, then 512 indices at
//     the chunk's bit width (1, 2, 4, 8 or 16), little-endian within bytes
//
// Dense arrays index a storage chunk as x + z * 32 + y * 1024.

import { ByteReader, ByteWriter } from "./bytes.ts";

export const STORAGE_BITS = 5;
export const STORAGE_SIZE = 1 << STORAGE_BITS;
export const STORAGE_VOLUME = STORAGE_SIZE ** 3;
const BRICK = 8;
const BRICKS = STORAGE_SIZE / BRICK;
const VERSION = 1;

const widthFor = (n: number) => (n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : n <= 256 ? 8 : 16);

/** Encodes a dense 32³ array of state ids. Returns null if the chunk is empty. */
export function encodeStorageChunk(dense: Uint16Array): Uint8Array | null {
  // Which ids occur, through a lookup table rather than a Set (this runs on every cell).
  let max = 0;
  for (let i = 0; i < dense.length; i++) if ((dense[i] ?? 0) > max) max = dense[i] ?? 0;
  if (max === 0) return null;
  const local = new Uint16Array(max + 1);
  for (let i = 0; i < dense.length; i++) local[dense[i] ?? 0] = 1;
  local[0] = 0; // empty stays local index 0
  const ids: number[] = [];
  for (let id = 1; id <= max; id++) {
    if (local[id]) {
      ids.push(id);
      local[id] = ids.length;
    }
  }
  const bits = widthFor(ids.length + 1);
  const w = new ByteWriter();
  w.u8(VERSION);
  w.varint(ids.length);
  for (const id of ids) w.varint(id);
  const brick = new Uint16Array(BRICK ** 3);
  for (let by = 0; by < BRICKS; by++) {
    for (let bz = 0; bz < BRICKS; bz++) {
      for (let bx = 0; bx < BRICKS; bx++) {
        let i = 0;
        for (let y = 0; y < BRICK; y++)
          for (let z = 0; z < BRICK; z++)
            for (let x = 0; x < BRICK; x++) {
              const id =
                dense[
                  bx * BRICK +
                    x +
                    (bz * BRICK + z) * STORAGE_SIZE +
                    (by * BRICK + y) * STORAGE_SIZE ** 2
                ] ?? 0;
              brick[i++] = local[id] ?? 0;
            }
        const first = brick[0] ?? 0;
        if (brick.every((v) => v === first)) {
          if (first === 0) w.u8(0);
          else {
            w.u8(1);
            w.varint(first);
          }
          continue;
        }
        w.u8(2);
        w.bytes(pack(brick, bits));
      }
    }
  }
  return w.finish();
}

/** Decodes a storage chunk into `out` (a dense 32³ array), which is overwritten. */
export function decodeStorageChunk(data: Uint8Array, out: Uint16Array): Uint16Array {
  const r = new ByteReader(data);
  const version = r.u8();
  if (version !== VERSION) throw new Error(`Unknown storage chunk version ${version}`);
  const n = r.varint();
  const palette = [0];
  for (let i = 0; i < n; i++) palette.push(r.varint());
  const bits = widthFor(n + 1);
  const bytes = (BRICK ** 3 * bits) / 8;
  const brick = new Uint16Array(BRICK ** 3);
  for (let by = 0; by < BRICKS; by++) {
    for (let bz = 0; bz < BRICKS; bz++) {
      for (let bx = 0; bx < BRICKS; bx++) {
        const mode = r.u8();
        if (mode === 2) unpack(r.bytes(bytes), bits, brick);
        else brick.fill(mode === 1 ? r.varint() : 0);
        let i = 0;
        for (let y = 0; y < BRICK; y++)
          for (let z = 0; z < BRICK; z++)
            for (let x = 0; x < BRICK; x++) {
              const index =
                bx * BRICK +
                x +
                (bz * BRICK + z) * STORAGE_SIZE +
                (by * BRICK + y) * STORAGE_SIZE ** 2;
              const id = palette[brick[i++] ?? 0];
              if (id === undefined) throw new Error("Storage chunk index out of its palette");
              out[index] = id;
            }
      }
    }
  }
  return out;
}

function pack(values: Uint16Array, bits: number): Uint8Array {
  const out = new Uint8Array((values.length * bits) / 8);
  if (bits === 16) {
    values.forEach((v, i) => {
      out[i * 2] = v & 0xff;
      out[i * 2 + 1] = v >> 8;
    });
    return out;
  }
  const perByte = 8 / bits;
  values.forEach((v, i) => {
    const at = Math.floor(i / perByte);
    out[at] = (out[at] ?? 0) | (v << ((i % perByte) * bits));
  });
  return out;
}

function unpack(data: Uint8Array, bits: number, out: Uint16Array): void {
  if (bits === 16) {
    for (let i = 0; i < out.length; i++)
      out[i] = (data[i * 2] ?? 0) | ((data[i * 2 + 1] ?? 0) << 8);
    return;
  }
  const perByte = 8 / bits;
  const mask = (1 << bits) - 1;
  for (let i = 0; i < out.length; i++) {
    out[i] = ((data[Math.floor(i / perByte)] ?? 0) >> ((i % perByte) * bits)) & mask;
  }
}
