import { describe, expect, it } from "vitest";
import { decodePng } from "../src/index.ts";
import { pngGrey } from "./helpers.ts";

describe("interlaced PNGs", () => {
  // Odd sizes make some of the seven passes short or empty.
  const sizes = [
    [1, 1],
    [3, 2],
    [5, 7],
    [9, 9],
    [16, 16],
    [13, 4],
  ] as const;

  for (const depth of [1, 2, 4, 8] as const) {
    it(`reads ${depth}-bit greyscale the same as the plain image`, async () => {
      for (const [w, h] of sizes) {
        const levels = Array.from({ length: w * h }, (_, i) => (i * 7 + (i >> 2)) % (1 << depth));
        const plain = await decodePng(await pngGrey(w, h, levels, depth, false));
        const woven = await decodePng(await pngGrey(w, h, levels, depth, true));
        expect(woven.width).toBe(w);
        expect(woven.height).toBe(h);
        expect(Array.from(woven.rgba)).toEqual(Array.from(plain.rgba));
        // And the plain one really holds the levels, scaled to 8 bits.
        const first = plain.rgba[0] ?? -1;
        expect(first).toBe(Math.round(((levels[0] ?? 0) * 255) / ((1 << depth) - 1)));
      }
    });
  }
});
