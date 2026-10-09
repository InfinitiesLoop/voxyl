import { describe, expect, it } from "vitest";
import { call, fingerprint, ok, setup } from "./helpers.ts";

const box = (...b: number[]) => ({ box: b });

describe("one undo step per call", () => {
  it("reverts a multi-command call as one step, and redo brings it back", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Glass" });
    const start = fingerprint(project);
    const startCells = project.world.cellCount;
    // hollow runs two commands: clear the inside, then fill the shell.
    await ok(host, "fill", {
      where: box(0, 0, 0, 4, 4, 4),
      semantic: "Wall",
      style: "hollow",
      op_id: "room",
    });
    expect(project.world.cellCount).toBe(98);
    const hollow = project.history.filter((e) => e.command.group === "claude:room");
    expect(hollow.map((e) => e.command.id)).toEqual(["room:1", "room:2"]);
    expect(
      hollow.every((e) => e.command.label === "Claude: fill" && e.command.source === "Claude"),
    ).toBe(true);

    const undone = await ok(host, "history", { action: "undo" });
    expect(undone.undone).toEqual(["Claude: fill"]);
    expect(project.world.cellCount).toBe(startCells);
    expect(project.world.getId(2, 2, 2)).not.toBe(0);
    expect(project.world.getId(0, 0, 0)).toBe(project.world.getId(2, 2, 2));
    expect(undone.next_undo).toBe("Claude: fill");
    expect(undone.next_redo).toBe("Claude: fill");

    const redone = await ok(host, "history", { action: "redo" });
    expect(redone.redone).toEqual(["Claude: fill"]);
    expect(project.world.cellCount).toBe(98);
    expect(project.world.getId(2, 2, 2)).toBe(0);
    // And back to exactly where it started.
    await ok(host, "history", { action: "undo" });
    expect(project.world.cellCount).toBe(startCells);
    expect(start).not.toBe("");
  });

  it("a failing later command leaves nothing applied", async () => {
    const { host, project } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 2, 2, 2), semantic: "Glass" });
    const before = fingerprint(project);
    // The clear of the inside is fine; the fill of the shell is outside the world.
    const r = await call(host, "fill", {
      where: box(0, 0, 0, 10 ** 9, 2, 2),
      semantic: "Wall",
      style: "hollow",
    });
    expect(r.ok).toBe(false);
    expect(fingerprint(project)).toBe(before);
  });
});

describe("history tool", () => {
  it("lists steps, groups multi-command calls, and counts undo and redo", async () => {
    const { host } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Wall" });
    await ok(host, "fill", { where: box(0, 0, 0, 4, 4, 4), semantic: "Floor", style: "hollow" });
    await ok(host, "clear", { where: box(0, 0, 0, 0, 0, 0) });
    const list = await ok(host, "history", { action: "list" });
    expect(list.total_steps).toBe(3);
    expect(list.steps).toEqual([
      { label: "Claude: fill", source: "Claude", commands: 1, state: "active" },
      { label: "Claude: fill", source: "Claude", commands: 2, state: "active" },
      { label: "Claude: clear", source: "Claude", commands: 1, state: "active" },
    ]);
    expect(list.next_undo).toBe("Claude: clear");
    expect(list.next_redo).toBeNull();

    const two = await ok(host, "history", { action: "undo", count: 2 });
    expect(two.undone).toEqual(["Claude: clear", "Claude: fill"]);
    const after = await ok(host, "history", { action: "list", count: 1 });
    expect(after.steps).toHaveLength(1);
    expect(after.steps[0].state).toBe("undone");
    expect(after.next_redo).toBe("Claude: fill");

    const redo = await ok(host, "history", { action: "redo", count: 5 });
    expect(redo.redone).toEqual(["Claude: fill", "Claude: clear"]);
    expect(redo.problems).toEqual(["Nothing more to redo."]);
  });

  it("says when there is nothing to undo, and a new edit ends redo", async () => {
    const { host } = setup();
    const none = await ok(host, "history", { action: "undo" });
    expect(none.undone).toEqual([]);
    expect(none.problems).toEqual(["Nothing more to undo."]);
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Wall" });
    await ok(host, "history", { action: "undo" });
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Floor" });
    expect((await ok(host, "history", { action: "redo" })).redone).toEqual([]);
  });

  it("undoes the user's own edits too, and repeats are harmless", async () => {
    const { host, project } = setup();
    for (const [id, x] of [
      ["user-1", 0],
      ["user-2", 5],
    ] as const) {
      project.run({
        id,
        kind: "fill",
        args: { where: box(x, 0, 0, x + 2, 0, 0), state: { semantic: 1 } },
        source: "editor",
        label: id === "user-2" ? "Draw" : "Draw first",
      });
    }
    const status = await ok(host, "status");
    expect(status.history.next_undo).toBe("Draw");
    const first = await ok(host, "history", { action: "undo", op_id: "u1" });
    expect(first.undone).toEqual(["Draw"]);
    expect(project.world.cellCount).toBe(3);
    const again = await ok(host, "history", { action: "undo", op_id: "u1" });
    expect(again.duplicate).toBe(true);
    expect(project.world.cellCount).toBe(3);
  });

  it("notifies the host once per real call", async () => {
    const { host } = setup();
    await ok(host, "fill", { where: box(0, 0, 0, 1, 0, 0), semantic: "Wall", dry_run: true });
    expect(host.changes).toHaveLength(0);
    await ok(host, "fill", {
      where: box(0, 0, 0, 4, 4, 4),
      semantic: "Wall",
      style: "hollow",
      op_id: "x",
    });
    expect(host.changes).toEqual([{ tool: "fill", commandIds: ["x:1", "x:2"] }]);
    await ok(host, "history", { action: "undo", count: 1 });
    expect(host.changes).toHaveLength(2);
    expect(host.changes[1]?.tool).toBe("history");
  });
});
