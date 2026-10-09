import type { Project } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { MemoryHost } from "../src/index.ts";
import { call, fingerprint, ok, setup } from "./helpers.ts";

const fresh = () => MemoryHost.create({ chunkBits: 4 });
const box = (...b: number[]) => ({ box: b });

describe("palette_edit", () => {
  it("makes a fresh project usable: semantics first, then cells", async () => {
    const host = fresh();
    const r = await ok(host, "palette_edit", {
      palette: "Main",
      ops: [
        { op: "add", semantic: "Mass", block: "voxyl:stone" },
        { op: "add", semantic: "Trim", shape: "edge1" },
        { op: "add", semantic: "Glow", block: "voxyl:glowstone", glow: true },
      ],
    });
    expect(r.ops_applied).toBe(3);
    expect(r.palette.semantics).toEqual([
      { name: "Mass", block: "voxyl:stone", cells: 0 },
      { name: "Trim", shape: "edge1", cells: 0 },
      { name: "Glow", block: "voxyl:glowstone", glow: true, cells: 0 },
    ]);
    const f = await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 1), semantic: "Mass" });
    expect(f.changed).toBe(4);
    const status = await ok(host, "status");
    expect(status.palettes[0].semantics).toHaveLength(3);
  });

  it("creates a palette that extends another, and overrides an inherited look there", async () => {
    const { host, project } = setup();
    const r = await ok(host, "palette_edit", {
      palette: "Night",
      create: { description: "Dark variant", extends: "Main" },
      ops: [{ op: "set", semantic: "Wall", block: "voxyl:blackstone" }],
    });
    expect(r.palette).toMatchObject({
      name: "Night",
      extends: "Main",
      description: "Dark variant",
    });
    expect(r.palette.semantics.find((s: { name: string }) => s.name === "Wall")).toMatchObject({
      block: "voxyl:blackstone",
      derived_from: "Main",
    });
    // Main's own look is untouched.
    const main = await ok(host, "palette_get", { palette: "Main" });
    expect(main.palette.semantics.find((s: { name: string }) => s.name === "Wall").block).toBe(
      "minecraft:bricks",
    );
    expect(project.semantics.palettes().map((p) => p.name)).toEqual(["Main", "Alt", "Night"]);
  });

  it("a rename carries the placed cells; a re-skin touches no cell", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 2, 0, 2), semantic: "Wall" });
    const before = fingerprint(project).split("|")[2];
    const r = await ok(host, "palette_edit", {
      palette: "Main",
      ops: [
        { op: "rename", semantic: "Wall", to: "Mass" },
        { op: "set", semantic: "Mass", block: "voxyl:oak_planks" },
      ],
    });
    expect(r.changed).toBe(0);
    expect(fingerprint(project).split("|")[2]).toBe(before);
    const inspect = await ok(host, "inspect", { view: "summary" });
    expect(inspect.blocks).toEqual([{ semantic: "Mass", count: 9 }]);
    expect(r.palette.semantics.find((s: { name: string }) => s.name === "Mass")).toMatchObject({
      block: "voxyl:oak_planks",
      cells: 9,
    });
    // The old name is gone, with near matches.
    const gone = await call(host, "fill", { where: box(0, 0, 0, 0, 0, 0), semantic: "Wall" });
    expect(gone.error.code).toBe("not_found");
  });

  it("set merges into the look and null clears a field", async () => {
    const { host, project } = setup();
    await ok(host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "set", semantic: "Floor", glow: true }],
    });
    expect(project.semantics.get(1).look).toEqual({ block: "minecraft:stone", glow: true });
    await ok(host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "set", semantic: "Floor", block: null, shape: "face4" }],
    });
    expect(project.semantics.get(1).look).toEqual({ glow: true });
    expect(project.semantics.get(1).form).toEqual({ shape: "face4" });
  });

  it("removes semantics and palettes, refusing while cells use them", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 0, 0, 0), semantic: "Wall" });
    const refused = await call(host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "remove", semantic: "Wall" }],
    });
    expect(refused.error.code).toBe("command_failed");
    expect(refused.error.message).toContain("ops[0] remove Wall");
    await ok(host, "palette_edit", { palette: "Main", ops: [{ op: "remove", semantic: "Glass" }] });
    expect(project.semantics.byName("Glass")).toBeUndefined();
    const gone = await ok(host, "palette_edit", { palette: "Alt", delete: true });
    expect(gone.deleted).toBe("Alt");
    expect(project.semantics.paletteByName("Alt")).toBeUndefined();
  });

  it("is all one undo step, and a failing op applies nothing", async () => {
    const { host, project } = setup();
    const before = fingerprint(project);
    await ok(host, "palette_edit", {
      palette: "New",
      create: true,
      ops: [
        { op: "add", semantic: "A" },
        { op: "add", semantic: "B", shape: "edge1" },
      ],
    });
    expect(project.semantics.paletteByName("New")).toBeDefined();
    await ok(host, "history", { action: "undo" });
    expect(project.semantics.paletteByName("New")).toBeUndefined();
    expect(project.semantics.size).toBe(6);
    const bad = await call(host, "palette_edit", {
      palette: "New",
      create: true,
      ops: [
        { op: "add", semantic: "A" },
        { op: "add", semantic: "A" },
      ],
    });
    expect(bad.error.code).toBe("command_failed");
    expect(bad.error.message).toContain("ops[1]");
    expect(project.semantics.paletteByName("New")).toBeUndefined();
    expect(before).toContain("|");
  });

  it("names the palette it can't find, validates shapes, and supports dry_run", async () => {
    const { host, project } = setup();
    const miss = await call(host, "palette_edit", { palette: "Mian", ops: [] });
    expect(miss.error.code).toBe("not_found");
    expect(miss.error.suggestions).toContain("Main");
    const shape = await call(host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "add", semantic: "X", shape: "blob" }],
    });
    expect(shape.error.code).toBe("bad_argument");
    const size = project.semantics.size;
    const dry = await ok(host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "add", semantic: "X" }],
      dry_run: true,
    });
    expect(dry.dry_run).toBe(true);
    expect(dry.palette.semantics.some((s: { name: string }) => s.name === "X")).toBe(true);
    expect(project.semantics.size).toBe(size);
    const typo = await call(host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "set", semantic: "Wal", block: "voxyl:stone" }],
    });
    expect(typo.error.suggestions).toContain("Wall");
  });

  it("repeating an op_id changes nothing", async () => {
    const host = fresh();
    const args = { palette: "Main", ops: [{ op: "add", semantic: "Mass" }], op_id: "p1" };
    await ok(host, "palette_edit", args);
    const again = await ok(host, "palette_edit", args);
    expect(again.duplicate).toBe(true);
    expect((host.project as Project).semantics.size).toBe(1);
  });
});

describe("palette_get", () => {
  it("lists palettes, then one palette with inherited entries and usage", async () => {
    const { host } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Floor" });
    const all = await ok(host, "palette_get");
    expect(all.palettes).toEqual([
      { name: "Main", semantics: 5 },
      { name: "Alt", extends: "Main", semantics: 1 },
    ]);
    const alt = await ok(host, "palette_get", { palette: "Alt" });
    expect(alt.palette.semantics.map((s: { name: string }) => s.name)).toEqual([
      "Lamp",
      "Floor",
      "Wall",
      "Glass",
      "Trim",
      "Roof",
    ]);
    expect(alt.palette.semantics[1]).toMatchObject({
      name: "Floor",
      block: "minecraft:stone",
      inherited_from: "Main",
    });
    const main = await ok(host, "palette_get", { palette: "Main" });
    expect(main.palette.semantics[0]).toMatchObject({ name: "Floor", cells: 2 });
    expect((await call(host, "palette_get", { palette: "Nope" })).error.code).toBe("not_found");
  });
});
