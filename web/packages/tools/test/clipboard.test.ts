import { describe, expect, it } from "vitest";
import { call, fingerprint, ok, setup } from "./helpers.ts";

const box = (...b: number[]) => ({ box: b });
const cellsOf = async (host: Parameters<typeof ok>[0]) =>
  (await ok(host, "inspect", { view: "cells", limit: 1000 })).cells as {
    at: number[];
    semantic?: string;
    facing?: string;
  }[];

describe("copy and paste", () => {
  it("copies a region and pastes it turned, anchored on its centre", async () => {
    const { host, project } = setup();
    await ok(host, "build", {
      origin: [0, 0, 0],
      legend: { W: "Wall", F: "Floor" },
      layers: [["WFF"]],
    });
    const c = await ok(host, "copy", { where: box(0, 0, 0, 2, 0, 0) });
    expect(c.copied).toBe(3);
    expect(c.anchor).toEqual([1, 0, 0]);
    expect(host.clip).not.toBeNull();
    const before = project.history.length;
    // Anchor (the middle cell) lands on [10, 0, 10]; one quarter turn clockwise: +X becomes +Z.
    const p = await ok(host, "paste", { at: [10, 0, 10], turn: 1 });
    expect(p.changed).toBe(3);
    expect(project.history.length - before).toBe(1);
    const placed = (await cellsOf(host)).filter((x) => x.at[0] === 10);
    expect(placed.map((x) => `${x.at.join(",")}:${x.semantic}`)).toEqual([
      "10,0,9:Wall",
      "10,0,10:Floor",
      "10,0,11:Floor",
    ]);
  });

  it("cut clears the region as one step; dry runs touch nothing", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 1), semantic: "Wall" });
    const before = fingerprint(project);
    const dry = await ok(host, "copy", { where: box(0, 0, 0, 1, 0, 1), cut: true, dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(host.clip).toBeNull();
    expect(fingerprint(project)).toBe(before);
    await ok(host, "copy", { where: box(0, 0, 0, 1, 0, 1), cut: true });
    expect(project.world.cellCount).toBe(0);
    const pasted = await ok(host, "paste", {
      at: [5, 0, 5],
      mirror: "x",
      repeat: { count: 2, step: [4, 0, 0] },
    });
    expect(pasted.changed).toBe(8);
    expect(pasted.copies).toBe(2);
  });

  it("says so when the clipboard is empty or the region holds nothing", async () => {
    const { host } = setup();
    expect((await call(host, "paste", { at: [0, 0, 0] })).error.code).toBe("clipboard_empty");
    const r = await ok(host, "copy", { where: box(0, 0, 0, 1, 1, 1) });
    expect(r.problems[0]).toContain("no cells");
  });

  it("symmetry copies a paste", async () => {
    const { host } = setup();
    await ok(host, "place", { at: [[0, 0, 0]], semantic: "Wall" });
    await ok(host, "copy", { where: box(0, 0, 0, 0, 0, 0) });
    const p = await ok(host, "paste", { at: [2, 0, 3], symmetry: { rotate4: [5.5, 5.5] } });
    expect(p.copies).toBe(4);
    expect(p.changed).toBe(4);
  });
});

describe("transform rotate", () => {
  it("turns blocks in place and reports unchanged ones", async () => {
    const { host } = setup();
    await ok(host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "add", semantic: "Stair", block: "minecraft:stone", placement: "stairs" }],
    });
    await ok(host, "place", {
      cells: [
        { at: [0, 0, 0], semantic: "Stair", facing: "north" },
        { at: [1, 0, 0], semantic: "Wall" },
      ],
    });
    const r = await ok(host, "transform", { where: box(0, 0, 0, 1, 0, 0), rotate: { turns: 1 } });
    expect(r.rotated + r.unchanged).toBe(2);
    const stair = (await cellsOf(host)).find((c) => c.semantic === "Stair");
    expect(stair?.facing).toBe("east");
    expect(
      (await call(host, "transform", { where: box(0, 0, 0, 1, 0, 0), rotate: {}, by: [1, 0, 0] }))
        .error.code,
    ).toBe("bad_argument");
  });
});

describe("palette link", () => {
  const shared = {
    key: "k1",
    version: 3,
    name: "Concrete",
    semantics: [
      { key: "a", name: "Base", look: { block: "minecraft:stone" } },
      { key: "b", name: "Trim", look: { block: "minecraft:bricks" } },
    ],
  };

  it("lists shared palettes and links one as a read-only copy", async () => {
    const { host, project } = setup();
    host.shared = [shared];
    const list = await ok(host, "palette_get", { shared: true });
    expect(list.shared_palettes).toMatchObject([{ name: "Concrete", version: 3, semantics: 2 }]);
    const r = await ok(host, "palette_edit", { link: "concrete" });
    expect(r.palette).toMatchObject({ name: "Concrete", linked: true });
    expect(r.palette.semantics.map((s: { name: string }) => s.name)).toEqual(["Base", "Trim"]);
    // A palette of our own extends the copy and uses its semantics.
    await ok(host, "palette_edit", { palette: "Mine", create: { extends: "Concrete" } });
    await ok(host, "fill", {
      where: box(0, 0, 0, 0, 0, 0),
      semantic: { name: "Base", palette: "Mine" },
    });
    expect(project.world.cellCount).toBe(1);
    // Editing the linked copy itself is refused; unlinking makes it editable.
    expect(
      (
        await call(host, "palette_edit", {
          palette: "Concrete",
          ops: [{ op: "add", semantic: "X" }],
        })
      ).ok,
    ).toBe(false);
    await ok(host, "palette_edit", { palette: "Concrete", unlink: true });
    const again = await ok(host, "palette_edit", {
      palette: "Concrete",
      ops: [{ op: "add", semantic: "X" }],
    });
    expect(again.ops_applied).toBe(1);
  });

  it("an unknown shared palette gets near matches; no host support is unavailable", async () => {
    const { host } = setup();
    host.shared = [shared];
    const r = await call(host, "palette_edit", { link: "Concret" });
    expect(r.error.code).toBe("not_found");
    expect(r.error.suggestions).toContain("Concrete");
    expect((await call(host, "palette_edit", {})).error.code).toBe("bad_argument");
  });
});
