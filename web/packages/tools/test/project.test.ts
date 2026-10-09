import { describe, expect, it } from "vitest";
import { MemoryHost } from "../src/index.ts";
import { call, ok } from "./helpers.ts";

const fresh = () => MemoryHost.create({ chunkBits: 4 });
const withWall = async () => {
  const host = fresh();
  await ok(host, "palette_edit", {
    palette: "Main",
    ops: [{ op: "add", semantic: "Wall", block: "voxyl:stone" }],
  });
  return host;
};

describe("project tools", () => {
  it("creates, saves, lists and opens projects by name, keeping status accurate", async () => {
    const host = await withWall();
    expect((await ok(host, "status")).project.saved).toBe(false);
    await ok(host, "project_settings", { name: "Scratch" });
    await ok(host, "fill", { where: { box: [0, 0, 0, 1, 0, 1] }, semantic: "Wall" });
    const saved = await ok(host, "project_save");
    expect(saved).toMatchObject({ saved: "Scratch", cells: 4 });
    expect((await ok(host, "status")).project.saved).toBe(true);

    const created = await ok(host, "project_create", { name: "Tower" });
    expect(created.created).toBe("Tower");
    let status = await ok(host, "status");
    expect(status.project).toMatchObject({ name: "Tower", saved: true, cells: 0 });

    const list = await ok(host, "project_list");
    expect(list.projects.map((p: { name: string }) => p.name)).toEqual(["Tower", "Scratch"]);
    expect(list.projects[0].open).toBe(true);
    expect(list.open).toBe("Tower");

    const opened = await ok(host, "project_open", { name: "scratch" });
    expect(opened.opened).toBe("Scratch");
    status = await ok(host, "status");
    expect(status.project).toMatchObject({ name: "Scratch", cells: 4 });
    // The tab was asked to show each of them, in order.
    expect(host.effects.map((e) => e.kind)).toEqual([
      "project_saved",
      "open_project",
      "open_project",
    ]);
  });

  it("warns when an unsaved project would be lost, and previews with dry_run", async () => {
    const host = fresh();
    await ok(host, "project_settings", { name: "Keep" });
    await ok(host, "project_save");
    await ok(host, "project_create", { name: "Other" });
    await ok(host, "project_open", { name: "Keep" });
    // A project never saved: open another and say so.
    const lone = fresh();
    lone.savedProjects.set("x", {
      info: { id: "x", name: "X", cells: 0, savedAt: 1 },
      project: fresh().project as never,
    });
    const dry = await ok(lone, "project_open", { name: "X", dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, would_open: "X", would_discard_unsaved: true });
    expect(lone.effects).toEqual([]);
    const real = await ok(lone, "project_open", { name: "X" });
    expect(real.problems[0]).toContain("never been saved");
  });

  it("delete needs confirm and says if the open project went", async () => {
    const host = fresh();
    await ok(host, "project_create", { name: "Doomed" });
    const refused = await call(host, "project_delete", { name: "Doomed" });
    expect(refused.error.code).toBe("confirm_required");
    expect((await ok(host, "project_list")).projects).toHaveLength(1);
    const gone = await ok(host, "project_delete", { name: "Doomed", confirm: true });
    expect(gone).toMatchObject({ deleted: "Doomed", was_open: true });
    expect((await ok(host, "status")).project).toBeNull();
    expect((await call(host, "project_open", { name: "Doomed" })).error.code).toBe("not_found");
  });

  it("reads and changes settings as one undo step", async () => {
    const host = fresh();
    const read = await ok(host, "project_settings");
    expect(read.settings).toMatchObject({ north: "north", grid: [0, 0] });
    const r = await ok(host, "project_settings", { north: "east", grid: [4, 2], note: "hi" });
    expect(r.settings).toMatchObject({ north: "east", grid: [4, 2], note: "hi" });
    expect((await call(host, "project_settings", { grid: [16, 0] })).error.code).toBe(
      "bad_argument",
    );
    const dry = await ok(host, "project_settings", { north: "south", dry_run: true });
    expect(dry.settings.north).toBe("south");
    expect(host.project?.settings.north).toBe("east");
    await ok(host, "history", { action: "undo" });
    expect(host.project?.settings.north).toBe("north");
  });

  it("a mutating tool fails with project_changed when the open project is not the expected one", async () => {
    const host = await withWall();
    await ok(host, "project_settings", { name: "Alpha" });
    const r = await call(host, "fill", {
      where: { box: [0, 0, 0, 0, 0, 0] },
      semantic: "Wall",
      project: "Beta",
    });
    expect(r.error.code).toBe("project_changed");
    expect(r.error.open).toBe("Alpha");
    expect(host.project?.world.cellCount).toBe(0);
    const fine = await ok(host, "fill", {
      where: { box: [0, 0, 0, 0, 0, 0] },
      semantic: "Wall",
      project: "alpha",
    });
    expect(fine.changed).toBe(1);
  });
});
