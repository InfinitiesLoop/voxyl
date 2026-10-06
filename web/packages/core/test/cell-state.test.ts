import { describe, expect, it } from "vitest";
import { CellStateTable, EMPTY_ID, NO_SEMANTIC, semanticsOf } from "../src/index.ts";

const MASS = 1;
const TRIM = 2;

describe("CellStateTable", () => {
  it("gives equal states the same id", () => {
    const table = new CellStateTable();
    const a = table.intern({ semantic: MASS });
    const b = table.intern({ semantic: MASS, rotation: 0, tags: {} });
    expect(a).toBe(b);
    expect(a).not.toBe(EMPTY_ID);
    expect(table.size).toBe(1);
  });

  it("ignores tag order", () => {
    const table = new CellStateTable();
    const a = table.intern({ semantic: TRIM, tags: { lit: true, axis: "y" } });
    const b = table.intern({ semantic: TRIM, tags: { axis: "y", lit: true } });
    expect(a).toBe(b);
  });

  it("separates states that differ in rotation, tags or parts", () => {
    const table = new CellStateTable();
    const ids = new Set([
      table.intern({ semantic: TRIM }),
      table.intern({ semantic: TRIM, rotation: 1 }),
      table.intern({ semantic: TRIM, tags: { axis: "y" } }),
      table.intern({ parts: [{ semantic: TRIM, shape: "slab", slot: 0 }] }),
    ]);
    expect(ids.size).toBe(4);
  });

  it("keeps a cell of parts free of a block semantic, and lists each part's", () => {
    const table = new CellStateTable();
    const id = table.intern({
      parts: [
        { semantic: TRIM, shape: "strip", slot: 3 },
        { semantic: MASS, shape: "slab", slot: 0 },
      ],
    });
    const state = table.get(id);
    expect(state?.semantic).toBe(NO_SEMANTIC);
    expect(state && semanticsOf(state)).toEqual([TRIM, MASS]);
  });

  it("rejects a cell with no semantic, both a semantic and parts, or a bad rotation", () => {
    const table = new CellStateTable();
    expect(() => table.intern({})).toThrow(TypeError);
    expect(() => table.intern({ semantic: NO_SEMANTIC })).toThrow(TypeError);
    expect(() =>
      table.intern({ semantic: MASS, parts: [{ semantic: TRIM, shape: "slab", slot: 0 }] }),
    ).toThrow(TypeError);
    expect(() => table.intern({ semantic: MASS, rotation: 24 })).toThrow(TypeError);
  });

  it("returns null for empty and frozen states otherwise", () => {
    const table = new CellStateTable();
    const id = table.intern({ semantic: MASS, tags: { a: 1 } });
    expect(table.get(EMPTY_ID)).toBeNull();
    const state = table.get(id);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state?.tags)).toBe(true);
    expect(() => table.get(99)).toThrow(RangeError);
  });
});
