import { describe, expect, it } from "vitest";
import { tabGuardWanted } from "./tab-guard.ts";

describe("tab guard", () => {
  it("asks before closing while flying or with an unsaved project", () => {
    expect(tabGuardWanted({ hasProject: true, saved: true, flying: true })).toBe(true);
    expect(tabGuardWanted({ hasProject: true, saved: false, flying: false })).toBe(true);
  });

  it("stays out of the way for a saved project at rest, or no project", () => {
    expect(tabGuardWanted({ hasProject: true, saved: true, flying: false })).toBe(false);
    expect(tabGuardWanted({ hasProject: false, saved: false, flying: true })).toBe(false);
  });
});
