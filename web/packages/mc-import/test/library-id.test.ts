import { describe, expect, it } from "vitest";
import { libraryIdFor } from "../src/index.ts";

describe("libraryIdFor", () => {
  it("makes an id the library store accepts", () => {
    expect(libraryIdFor("pack-", "Automagy")).toBe("pack-automagy");
    expect(libraryIdFor("pack-", "ProjRed|Illumination")).toBe("pack-projred_illumination");
    expect(libraryIdFor("pack-", "x".repeat(100))).toHaveLength(64);
    for (const ns of ["BuildCraft|Core", "ExtraUtilities", "gregtech", "dreamcraft"]) {
      expect(libraryIdFor("pack-", ns)).toMatch(/^[a-z0-9_.-]{1,64}$/);
    }
  });
});
