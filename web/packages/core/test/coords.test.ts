import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ChunkLayout,
  chunkKey,
  chunkKeyToCoords,
  MAX_CHUNK_BITS,
  MAX_CHUNK_COORD,
  MIN_CHUNK_BITS,
  MIN_CHUNK_COORD,
} from "../src/index.ts";

const allBits = Array.from(
  { length: MAX_CHUNK_BITS - MIN_CHUNK_BITS + 1 },
  (_, i) => MIN_CHUNK_BITS + i,
);

describe.each(allBits)("ChunkLayout with %i-bit chunks", (bits) => {
  const L = new ChunkLayout(bits);
  const worldCoord = fc.integer({ min: L.minWorld, max: L.maxWorld });

  it("floors negative coordinates into the chunk below", () => {
    expect([L.toChunk(0), L.toLocal(0)]).toEqual([0, 0]);
    expect([L.toChunk(L.size - 1), L.toLocal(L.size - 1)]).toEqual([0, L.size - 1]);
    expect([L.toChunk(L.size), L.toLocal(L.size)]).toEqual([1, 0]);
    expect([L.toChunk(-1), L.toLocal(-1)]).toEqual([-1, L.size - 1]);
    expect([L.toChunk(-L.size), L.toLocal(-L.size)]).toEqual([-1, 0]);
    expect([L.toChunk(-L.size - 1), L.toLocal(-L.size - 1)]).toEqual([-2, L.size - 1]);
  });

  it("splits every world coordinate losslessly", () => {
    fc.assert(
      fc.property(worldCoord, (v) => {
        expect(L.toChunk(v) * L.size + L.toLocal(v)).toBe(v);
      }),
    );
  });

  it("gives each local position its own index", () => {
    const seen = new Uint8Array(L.volume);
    for (let y = 0; y < L.size; y++) {
      for (let z = 0; z < L.size; z++) {
        for (let x = 0; x < L.size; x++) {
          seen[L.localIndex(x, y, z)] = (seen[L.localIndex(x, y, z)] ?? 0) + 1;
        }
      }
    }
    expect(seen.every((n) => n === 1)).toBe(true);
  });

  it("accepts the edges of the world and rejects anything past them or fractional", () => {
    expect(() => L.assertWorldPos(L.minWorld, 0, L.maxWorld)).not.toThrow();
    expect(() => L.assertWorldPos(L.maxWorld + 1, 0, 0)).toThrow(RangeError);
    expect(() => L.assertWorldPos(0, L.minWorld - 1, 0)).toThrow(RangeError);
    expect(() => L.assertWorldPos(0, 0, 0.5)).toThrow(RangeError);
  });
});

describe("ChunkLayout", () => {
  it("rejects chunk sizes outside the supported range", () => {
    expect(() => new ChunkLayout(MIN_CHUNK_BITS - 1)).toThrow(RangeError);
    expect(() => new ChunkLayout(MAX_CHUNK_BITS + 1)).toThrow(RangeError);
    expect(() => new ChunkLayout(4.5)).toThrow(RangeError);
  });
});

describe("chunk keys", () => {
  const chunkCoord = fc.integer({ min: MIN_CHUNK_COORD, max: MAX_CHUNK_COORD });

  it("round-trip every chunk coordinate", () => {
    fc.assert(
      fc.property(chunkCoord, chunkCoord, chunkCoord, (cx, cy, cz) => {
        const key = chunkKey(cx, cy, cz);
        expect(Number.isSafeInteger(key)).toBe(true);
        expect(chunkKeyToCoords(key)).toEqual([cx, cy, cz]);
      }),
    );
  });
});
