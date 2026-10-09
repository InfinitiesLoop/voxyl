import { describe, expect, it } from "vitest";
import { MC_BLOCKS_NOTE, sampleNote, WORLD_KINDS } from "./worlds.ts";

describe("sample notes", () => {
  it("describes every sample, and the Minecraft one links to the jar import", () => {
    for (const { kind } of WORLD_KINDS) {
      expect(sampleNote(kind).length, kind).toBeGreaterThan(40);
    }
    expect(MC_BLOCKS_NOTE).toContain("[Import a Minecraft jar](blocks)");
    expect(sampleNote("mc-blocks")).toBe(MC_BLOCKS_NOTE);
    expect(sampleNote("city-5m")).toContain("5 million");
    expect(sampleNote("parts-5m")).toContain("shaped parts");
    expect(sampleNote("blocks")).not.toContain("Minecraft jar");
    for (const { kind } of WORLD_KINDS) {
      expect(sampleNote(kind), kind).toContain("sunset");
      expect(sampleNote(kind).toLowerCase(), kind).not.toContain("theme");
    }
  });
});
