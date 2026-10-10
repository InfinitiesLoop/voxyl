import { describe, expect, it } from "vitest";
import { packRgba } from "./pixels.ts";

describe("packRgba", () => {
  it("copies tight rows and flips WebGL's bottom-up order", () => {
    const tight = new Uint8Array([1, 0, 0, 255, 0, 1, 0, 255, 0, 0, 1, 255, 1, 1, 1, 255]);
    expect(Array.from(packRgba(tight, 2, 2, false))).toEqual(Array.from(tight));
    const flipped = packRgba(tight, 2, 2, true);
    expect(Array.from(flipped.subarray(0, 4))).toEqual([0, 0, 1, 255]);
    expect(Array.from(flipped.subarray(4, 8))).toEqual([1, 1, 1, 255]);
  });

  it("drops the 256-byte padding WebGPU puts on every row but the last", () => {
    const row = new Uint8Array(256);
    row.set([9, 8, 7, 6]);
    const last = new Uint8Array([1, 2, 3, 4]);
    const padded = new Uint8Array(256 + 4);
    padded.set(row, 0);
    padded.set(last, 256);
    const packed = packRgba(padded, 1, 2, false);
    expect(Array.from(packed)).toEqual([9, 8, 7, 6, 1, 2, 3, 4]);
  });
});
