import { describe, expect, it } from "vitest";
import { bakeBlockIcon, buildDefaultLibrary } from "../src/index.ts";

const libraries = new Map([["voxyl", buildDefaultLibrary()]]);

function opaque(icon: Uint8Array, size: number): { n: number; minY: number; maxY: number } {
  let n = 0;
  let minY = size;
  let maxY = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((icon[(y * size + x) * 4 + 3] ?? 0) > 16) {
        n++;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { n, minY, maxY };
}

describe("block icons", () => {
  it("frames a cube inside the icon, with the corners left clear", () => {
    const size = 64;
    const icon = bakeBlockIcon(libraries, "voxyl:stone", size);
    if (!icon) throw new Error("no icon");
    expect(icon).toHaveLength(size * size * 4);
    expect(icon[3]).toBe(0);
    const box = opaque(icon, size);
    expect(box.n).toBeGreaterThan(400);
    expect(box.minY).toBeGreaterThan(2);
    expect(box.maxY).toBeLessThan(size - 2);
    // The middle of the picture is the block.
    expect(icon[((size / 2) * size + size / 2) * 4 + 3]).toBeGreaterThan(200);
  });

  it("bakes a slab shorter than a cube, and stairs with less cover than a cube", () => {
    const size = 48;
    const cube = bakeBlockIcon(libraries, "voxyl:stone", size);
    const slab = bakeBlockIcon(libraries, "voxyl:stone_slab", size);
    const stairs = bakeBlockIcon(libraries, "voxyl:stone_stairs", size);
    const post = bakeBlockIcon(libraries, "voxyl:oak_fence", size);
    if (!cube || !slab || !stairs || !post) throw new Error("no icon");
    const full = opaque(cube, size);
    const half = opaque(slab, size);
    const step = opaque(stairs, size);
    // A bottom slab does not reach as high on screen (screen y grows downward).
    expect(half.minY).toBeGreaterThan(full.minY + 2);
    expect(half.n).toBeLessThan(full.n);
    expect(step.n).toBeLessThan(full.n);
    expect(opaque(post, size).n).toBeLessThan(half.n);
  });

  it("shades the top differently from a side", () => {
    const size = 64;
    const icon = bakeBlockIcon(libraries, "voxyl:stone", size);
    if (!icon) throw new Error("no icon");
    const at = (x: number, y: number) => {
      const i = (y * size + x) * 4;
      return [icon[i] ?? 0, icon[i + 1] ?? 0, icon[i + 2] ?? 0, icon[i + 3] ?? 0] as const;
    };
    // Walk down the centre column: the top face, then a side.
    let top: number | null = null;
    let side: number | null = null;
    let last = -1;
    for (let y = 0; y < size; y++) {
      const px = at(Math.floor(size / 2), y);
      if (px[3] < 200) continue;
      const lum = px[0] + px[1] + px[2];
      if (top === null) top = lum;
      if (last >= 0 && Math.abs(lum - last) > 30) side = lum;
      last = lum;
    }
    expect(top).not.toBeNull();
    expect(side).not.toBeNull();
    expect(top).not.toBe(side);
  });

  it("returns null for an unknown block", () => {
    expect(bakeBlockIcon(libraries, "voxyl:nope")).toBeNull();
    expect(bakeBlockIcon(libraries, "missing:stone")).toBeNull();
  });
});
