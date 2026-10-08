import { defaultLibrary } from "@voxyl/blocks";
import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTES } from "./default-palettes.ts";

describe("the starter palettes", () => {
  const blocks = defaultLibrary().blocks;

  it("use only blocks of the default set, once each per palette", () => {
    for (const palette of DEFAULT_PALETTES) {
      const names = new Set<string>();
      for (const s of palette.semantics) {
        const ref = s.look?.block ?? "";
        expect(ref.startsWith("voxyl:"), `${palette.name} ${s.name}`).toBe(true);
        expect(
          blocks[ref.slice("voxyl:".length)],
          `${palette.name} ${s.name}: ${ref}`,
        ).toBeDefined();
        expect(names.has(s.name), `${palette.name} repeats ${s.name}`).toBe(false);
        names.add(s.name);
      }
    }
  });

  it("have keys the palette store accepts, and none twice", () => {
    const keys = DEFAULT_PALETTES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9_.-]{1,64}$/);
    for (const palette of DEFAULT_PALETTES) {
      const own = palette.semantics.map((s) => s.key);
      expect(new Set(own).size).toBe(own.length);
    }
  });
});
