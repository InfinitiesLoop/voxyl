import { describe, expect, it } from "vitest";
import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import { HOTBAR_SLOTS, Hotbar } from "./hotbar.ts";

const info = (
  ref: SemanticInfo["ref"],
  name: string,
  palette = 1,
  base?: number,
): SemanticInfo => ({
  ref,
  palette,
  ...(base !== undefined && { base }),
  name,
  description: "",
  color: "#808080",
  glow: false,
  ownLook: {},
});

const palette = (id: number, semantics: SemanticInfo[]): PaletteInfo => ({
  id,
  name: `P${id}`,
  linked: false,
  semantics,
});

describe("Hotbar", () => {
  it("fills an empty hotbar from the root palette, then keeps its slots", () => {
    const hotbar = new Hotbar();
    hotbar.update([palette(1, [info(1, "Wall"), info(2, "Floor")])]);
    expect(
      hotbar.state
        .get()
        .slots.slice(0, 3)
        .map((s) => s?.name ?? null),
    ).toEqual(["Wall", "Floor", null]);
    expect(hotbar.current?.name).toBe("Wall");
    // A rename and a re-skin show; the slots stay where they were.
    hotbar.update([palette(1, [info(2, "Floor"), { ...info(1, "Stone wall"), color: "#111111" }])]);
    expect(hotbar.current).toMatchObject({ name: "Stone wall", color: "#111111" });
  });

  it("cycles both ways and wraps", () => {
    const hotbar = new Hotbar();
    hotbar.cycle(-1);
    expect(hotbar.state.get().selected).toBe(HOTBAR_SLOTS - 1);
    hotbar.cycle(2);
    expect(hotbar.state.get().selected).toBe(1);
    hotbar.select(99);
    expect(hotbar.state.get().selected).toBe(1);
  });

  it("follows a semantic from its base to the derived one, and drops removed ones", () => {
    const hotbar = new Hotbar();
    hotbar.update([palette(1, [info(1, "Wall"), info(3, "Gone")])]);
    // Picking what the hotbar has chooses its slot.
    hotbar.select(4);
    hotbar.pick(info(3, "Gone"));
    expect(hotbar.state.get().selected).toBe(1);
    // Palette 2's Wall, not derived yet, goes in the chosen slot.
    hotbar.select(2);
    hotbar.pick(info({ palette: 2, base: 1 }, "Wall", 2, 1));
    expect(hotbar.state.get().slots[2]?.ref).toEqual({ palette: 2, base: 1 });
    // Placed once: palette 2 now owns semantic 7, derived from 1. "Gone" was removed.
    hotbar.update([palette(1, [info(1, "Wall")]), palette(2, [info(7, "Wall", 2, 1)])]);
    const { slots } = hotbar.state.get();
    expect(slots[0]?.ref).toBe(1);
    expect(slots[1]).toBeNull();
    expect(slots[2]?.ref).toBe(7);
  });

  it("puts a semantic in the slot it was dropped on", () => {
    const hotbar = new Hotbar();
    hotbar.update([palette(1, [info(1, "Wall")])]);
    hotbar.assign(4, info(2, "Floor"));
    const { slots, selected } = hotbar.state.get();
    expect(selected).toBe(4);
    expect(slots[4]?.name).toBe("Floor");
    expect(slots[0]?.name).toBe("Wall");
  });
});
