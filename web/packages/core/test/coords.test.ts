import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertWorldPos,
  CHUNK_SIZE,
  chunkKey,
  chunkKeyToCoords,
  localIndex,
  MAX_CHUNK_COORD,
  MAX_WORLD_COORD,
  MIN_CHUNK_COORD,
  MIN_WORLD_COORD,
  toChunk,
  toLocal,
} from "../src/index.ts";

const worldCoord = fc.integer({ min: MIN_WORLD_COORD, max: MAX_WORLD_COORD });
const chunkCoord = fc.integer({ min: MIN_CHUNK_COORD, max: MAX_CHUNK_COORD });

describe("chunk and local coordinates", () => {
  it("floors negative coordinates into the chunk below", () => {
    expect([toChunk(0), toLocal(0)]).toEqual([0, 0]);
    expect([toChunk(31), toLocal(31)]).toEqual([0, 31]);
    expect([toChunk(32), toLocal(32)]).toEqual([1, 0]);
    expect([toChunk(-1), toLocal(-1)]).toEqual([-1, 31]);
    expect([toChunk(-32), toLocal(-32)]).toEqual([-1, 0]);
    expect([toChunk(-33), toLocal(-33)]).toEqual([-2, 31]);
  });

  it("splits every world coordinate losslessly", () => {
    fc.assert(
      fc.property(worldCoord, (v) => {
        expect(toChunk(v) * CHUNK_SIZE + toLocal(v)).toBe(v);
      }),
    );
  });

  it("gives each local position its own index", () => {
    const seen = new Set<number>();
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          seen.add(localIndex(x, y, z));
        }
      }
    }
    expect(seen.size).toBe(CHUNK_SIZE ** 3);
    expect(Math.max(...seen)).toBe(CHUNK_SIZE ** 3 - 1);
  });
});

describe("chunk keys", () => {
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

describe("world bounds", () => {
  it("accepts the edges and rejects anything past them or fractional", () => {
    expect(() => assertWorldPos(MIN_WORLD_COORD, 0, MAX_WORLD_COORD)).not.toThrow();
    expect(() => assertWorldPos(MAX_WORLD_COORD + 1, 0, 0)).toThrow(RangeError);
    expect(() => assertWorldPos(0, MIN_WORLD_COORD - 1, 0)).toThrow(RangeError);
    expect(() => assertWorldPos(0, 0, 0.5)).toThrow(RangeError);
  });
});
