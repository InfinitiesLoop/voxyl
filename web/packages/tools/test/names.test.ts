import { describe, expect, it } from "vitest";
import { nearMatches } from "../src/index.ts";
import { call, fingerprint, ok, setup } from "./helpers.ts";

describe("name resolution", () => {
  it("ranks near matches", () => {
    expect(nearMatches("flor", ["Wall", "Floor", "Roof"])[0]).toBe("Floor");
    expect(nearMatches("roo", ["Wall", "Floor", "Roof"])[0]).toBe("Roof");
  });

  it("lists near matches when a semantic name is unknown", async () => {
    const { host, project } = setup();
    const before = fingerprint(project);
    const r = await call(host, "fill", { where: { box: [0, 0, 0, 1, 1, 1] }, semantic: "Flor" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("not_found");
    expect(r.error.kind).toBe("semantic");
    expect(r.error.suggestions[0]).toBe("Floor");
    expect(r.error.message).toContain('Did you mean "Floor"');
    expect(fingerprint(project)).toBe(before);
  });

  it("matches case-insensitively when that is unambiguous", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: { box: [0, 0, 0, 1, 0, 1] }, semantic: "floor" });
    expect(project.world.cellCount).toBe(4);
  });

  it("reports an unknown palette with the palettes that exist", async () => {
    const { host } = setup();
    const r = await call(host, "inspect", { where: { palette: "Alt2" } });
    expect(r.error.code).toBe("not_found");
    expect(r.error.kind).toBe("palette");
    expect(r.error.suggestions).toContain("Alt");
  });

  it("asks for a palette when a name is in several, and takes {name, palette}", async () => {
    const { host, project } = setup();
    project.semantics.add("Floor", { palette: 2 });
    const r = await call(host, "fill", { where: { box: [0, 0, 0, 0, 0, 0] }, semantic: "Floor" });
    expect(r.error.code).toBe("ambiguous");
    expect(r.error.palettes).toEqual(["Main", "Alt"]);
    const fine = await call(host, "fill", {
      where: { box: [0, 0, 0, 0, 0, 0] },
      semantic: { name: "Floor", palette: "Alt" },
    });
    expect(fine.ok).toBe(true);
    expect(project.world.cellCount).toBe(1);
  });

  it("does not create anything when a region names a semantic nothing uses yet", async () => {
    const { host, project } = setup();
    const size = project.semantics.size;
    const r = await ok(host, "inspect", { where: { semantic: "Wall" } });
    expect(r.cells).toBe(0);
    expect(project.semantics.size).toBe(size);
  });
});
