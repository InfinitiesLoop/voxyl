import { describe, expect, it } from "vitest";
import { CellStateTable, EMPTY_ID } from "../src/index.ts";

describe("CellStateTable", () => {
  it("gives equal states the same id", () => {
    const table = new CellStateTable();
    const a = table.intern({ semantic: "Mass" });
    const b = table.intern({ semantic: "Mass", orientation: 0, tags: {} });
    expect(a).toBe(b);
    expect(a).not.toBe(EMPTY_ID);
    expect(table.size).toBe(1);
  });

  it("ignores tag order", () => {
    const table = new CellStateTable();
    const a = table.intern({ semantic: "Trim", tags: { lit: true, axis: "y" } });
    const b = table.intern({ semantic: "Trim", tags: { axis: "y", lit: true } });
    expect(a).toBe(b);
  });

  it("separates states that differ in orientation, tags or parts", () => {
    const table = new CellStateTable();
    const ids = new Set([
      table.intern({ semantic: "Trim" }),
      table.intern({ semantic: "Trim", orientation: 1 }),
      table.intern({ semantic: "Trim", tags: { axis: "y" } }),
      table.intern({ parts: [{ semantic: "Trim", shape: "slab", slot: 0 }] }),
    ]);
    expect(ids.size).toBe(4);
  });

  it("takes a shaped cell's semantic from its first part", () => {
    const table = new CellStateTable();
    const id = table.intern({
      parts: [
        { semantic: "Trim", shape: "strip", slot: 3 },
        { semantic: "Mass", shape: "slab", slot: 0 },
      ],
    });
    expect(table.get(id)?.semantic).toBe("Trim");
  });

  it("rejects a cell with no semantic", () => {
    const table = new CellStateTable();
    expect(() => table.intern({})).toThrow(TypeError);
    expect(() => table.intern({ semantic: "" })).toThrow(TypeError);
  });

  it("returns null for empty and frozen states otherwise", () => {
    const table = new CellStateTable();
    const id = table.intern({ semantic: "Mass", tags: { a: 1 } });
    expect(table.get(EMPTY_ID)).toBeNull();
    const state = table.get(id);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state?.tags)).toBe(true);
    expect(() => table.get(99)).toThrow(RangeError);
  });
});
