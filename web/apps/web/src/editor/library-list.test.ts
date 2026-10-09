import { describe, expect, it } from "vitest";
import {
  chooseOnly,
  filterLibraries,
  liveSelection,
  sortLibraries,
  toggleLibrary,
} from "./library-list.ts";

const libs = [
  { id: "b", name: "banana mod" },
  { id: "a", name: "Apple Pack" },
  { id: "voxyl", name: "Voxyl" },
  { id: "c", name: "Cherry" },
];

describe("library list", () => {
  it("sorts by name without regard to case", () => {
    expect(sortLibraries(libs).map((l) => l.name)).toEqual([
      "Apple Pack",
      "banana mod",
      "Cherry",
      "Voxyl",
    ]);
    expect(libs[0]?.id).toBe("b");
  });

  it("filters by every word of the name, any case", () => {
    expect(filterLibraries(libs, "").length).toBe(4);
    expect(filterLibraries(libs, "PACK app").map((l) => l.id)).toEqual(["a"]);
    expect(filterLibraries(libs, "zzz")).toEqual([]);
  });

  it("toggles, and a plain click chooses one alone or clears it", () => {
    expect([...toggleLibrary(new Set(["a"]), "b")]).toEqual(["a", "b"]);
    expect([...toggleLibrary(new Set(["a", "b"]), "a")]).toEqual(["b"]);
    expect([...chooseOnly(new Set(["a", "b"]), "a")]).toEqual(["a"]);
    expect(chooseOnly(new Set(["a"]), "a").size).toBe(0);
  });

  it("forgets libraries that are gone", () => {
    expect([...liveSelection(new Set(["a", "gone"]), libs)]).toEqual(["a"]);
  });
});
