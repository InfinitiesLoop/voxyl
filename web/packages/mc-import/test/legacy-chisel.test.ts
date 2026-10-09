import { describe, expect, it } from "vitest";
import {
  CHISEL_EXCLUDED_GROUPS,
  CHISEL_VARIATIONS,
  chiselGroups,
  chiselMetas,
  chiselTexture,
  isChiselPaneGroup,
} from "../src/legacy/chisel-variations.ts";

// The counts below were taken from scripts/mcimport/ChiselVariations.gd (116 groups, 1181
// metas). Duplicate group or meta keys cannot be asserted at run time (a later key silently
// replaces an earlier one), but TypeScript and Biome reject them in the source.

describe("Chisel variation table", () => {
  it("has every group and meta of the Godot table", () => {
    expect(chiselGroups()).toHaveLength(116);
    const metas = Object.values(CHISEL_VARIATIONS).reduce(
      (sum, group) => sum + Object.keys(group).length,
      0,
    );
    expect(metas).toBe(1181);
  });

  it("maps metas to texture base names, spot checked", () => {
    expect(chiselTexture("andesite", 0)).toBe("andesite/andesite");
    expect(chiselTexture("andesite", 6)).toBe("andesite/andesiteTiles");
    // Group keys keep Chisel's own casing, and the registry name beats the texture folder's.
    expect(chiselTexture("end_Stone", 0)).toBe("endstone/end_bricks");
    expect(chiselTexture("woolen_clay", 15)).toBe("woolenClay/black");
    // Loop-built groups the first decompile pass missed.
    expect(chiselTexture("cubit", 15)).toBe("15");
    expect(chiselTexture("sveltstone", 0)).toBeDefined();
    // Dye-name order (ink sac first), not wool order.
    expect(chiselTexture("antiBlock", 0)).toBe("antiblock/black-antiBlock");
    expect(chiselTexture("antiBlock", 15)).toBe("antiblock/white-antiBlock");
    // The odd-indexed colour of a pane pair sits at metas 8-13.
    expect(chiselTexture("stained_glass_pane_orange", 8)).toBe("glasspanedyed/orange-bubble");
    expect(chiselTexture("stained_glass_pane_orange", 0)).toBeUndefined();
  });

  it("keeps gaps as gaps and lists metas ascending", () => {
    expect(chiselTexture("glass_pane", 0)).toBeUndefined();
    expect(chiselTexture("glass_pane", 15)).toBe("glasspane/japanese2");
    expect(chiselMetas("glass_pane").map(([meta]) => meta)).toEqual([1, 2, 3, 4, 12, 13, 14, 15]);
    expect(chiselMetas("nothing")).toEqual([]);
    expect(chiselTexture("nothing", 0)).toBeUndefined();
  });

  it("leaves out the groups the bytecode cannot disambiguate", () => {
    expect(CHISEL_EXCLUDED_GROUPS).toEqual(["metalOre", "voidstone", "tallow"]);
    for (const group of CHISEL_EXCLUDED_GROUPS) expect(CHISEL_VARIATIONS[group]).toBeUndefined();
    expect(CHISEL_VARIATIONS.stained_glass_forestry).toBeUndefined();
  });

  it("has well-formed metas and texture names", () => {
    for (const [group, metas] of Object.entries(CHISEL_VARIATIONS)) {
      expect(Object.keys(metas).length, group).toBeGreaterThan(0);
      for (const [meta, texture] of Object.entries(metas)) {
        expect(Number.isInteger(Number(meta)) && Number(meta) >= 0 && Number(meta) < 256).toBe(
          true,
        );
        expect(texture, `${group} ${meta}`).toMatch(/^\S+$/);
      }
    }
  });

  it("has the dyed families: 16 colours of glass and of panes", () => {
    const glass = chiselGroups().filter((g) => /^stained_glass_[a-z]+$/.test(g));
    const panes = chiselGroups().filter((g) => g.startsWith("stained_glass_pane_"));
    expect(glass).toHaveLength(16);
    expect(panes).toHaveLength(16);
    for (const g of panes) expect(Object.keys(CHISEL_VARIATIONS[g] ?? {})).toHaveLength(6);
    for (const g of glass) expect(Object.keys(CHISEL_VARIATIONS[g] ?? {})).toHaveLength(4);
  });

  it("knows which groups are panes", () => {
    const panes = chiselGroups().filter(isChiselPaneGroup);
    expect(panes).toHaveLength(18);
    expect(panes).toContain("glass_pane");
    expect(panes).toContain("iron_bars");
    expect(isChiselPaneGroup("glass")).toBe(false);
    expect(isChiselPaneGroup("stained_glass_white")).toBe(false);
  });
});
