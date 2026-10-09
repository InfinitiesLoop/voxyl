import { describe, expect, it } from "vitest";
import { archSlotFor } from "../src/cell.ts";
import { call, ok, setup } from "./helpers.ts";

describe("up and facing on architecture shapes", () => {
  it("maps them onto the shape's slot", () => {
    // A roof tile in its own frame: top up, low end toward north.
    expect(archSlotFor("up", "north")).toBe(0);
    // Turning the low end gives the other three turns of the same side.
    const turns = (["north", "east", "south", "west"] as const).map((f) => archSlotFor("up", f));
    expect(new Set(turns).size).toBe(4);
    expect(turns.every((s) => s >= 0 && s < 4)).toBe(true);
    // Upside down and on its side are other sides.
    expect(archSlotFor("down", "north")).toBeGreaterThanOrEqual(4);
    expect(archSlotFor("north", undefined)).toBeGreaterThanOrEqual(0);
  });

  it("places a roof by facing, and slot wins when both are given", async () => {
    const { host } = setup();
    const cells = await ok(host, "place", {
      cells: [
        { at: [0, 0, 0], semantic: "Roof", facing: "north" },
        { at: [1, 0, 0], semantic: "Roof", up: "up", facing: "east" },
        { at: [2, 0, 0], semantic: "Roof", up: "down", facing: "south" },
        { at: [3, 0, 0], semantic: "Roof", slot: "up=up turn=0", facing: "east" },
      ],
    });
    expect(cells.rejected_count).toBe(0);
    expect(cells.problems[0]).toContain("facing and up ignored");
    const slots = (await ok(host, "inspect", { view: "cells" })).cells.map(
      (c: { parts: { slot: string }[] }) => c.parts[0]?.slot,
    );
    expect(slots[0]).toBe("up=up turn=0");
    expect(slots[3]).toBe("up=up turn=0");
    expect(new Set(slots).size).toBe(3);
    expect(slots[2]).toContain("up=down");
  });

  it("a micro shape ignores facing and says so", async () => {
    const { host } = setup();
    const r = await ok(host, "place", {
      cells: [{ at: [0, 0, 0], semantic: "Trim", slot: "north-east", facing: "east" }],
    });
    expect(r.changed).toBe(1);
    expect(r.problems[0]).toContain("facing and up ignored");
  });
});

describe("attached_to", () => {
  async function torchProject() {
    const s = setup();
    await ok(s.host, "palette_edit", {
      palette: "Main",
      ops: [{ op: "add", semantic: "Torch", placement: "torch", block: "voxyl:torch" }],
    });
    return s;
  }

  it("stands on the block below, or leans out of a wall", async () => {
    const { host, project } = await torchProject();
    const id = project.semantics.byName("Torch") as number;
    const profile = project.placement(id);
    await ok(host, "place", {
      cells: [
        { at: [0, 1, 0], semantic: "Torch", attached_to: "down" },
        { at: [1, 1, 0], semantic: "Torch", attached_to: "north" },
        { at: [2, 1, 0], semantic: "Torch", attached_to: "west" },
        { at: [3, 1, 0], semantic: "Torch" },
      ],
    });
    const held = [0, 1, 2, 3].map((x) => {
      const state = project.world.get(x, 1, 0);
      return state ? profile.attachedTo(state.rotation) : null;
    });
    expect(held).toEqual(["down", "north", "west", "down"]);
    const palette = await ok(host, "palette_get", { palette: "Main" });
    expect(palette.palette.semantics.at(-1)).toMatchObject({ name: "Torch", placement: "torch" });
  });

  it("refuses attached_to together with facing or up, and ignores it on parts", async () => {
    const { host } = await torchProject();
    const both = await call(host, "place", {
      cells: [{ at: [0, 0, 0], semantic: "Torch", attached_to: "north", up: "up" }],
    });
    expect(both.error.code).toBe("bad_argument");
    const part = await ok(host, "place", {
      cells: [{ at: [0, 0, 0], semantic: "Trim", slot: "north-east", attached_to: "north" }],
    });
    expect(part.problems[0]).toContain("attached_to ignored");
  });
});
