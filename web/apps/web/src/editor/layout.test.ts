import { describe, expect, it } from "vitest";
import {
  defaultLayout,
  focusedPane,
  presetFromParams,
  visibleCount,
  visiblePanes,
  withFocus,
  withPane,
  withPreset,
} from "./layout.ts";

describe("layout", () => {
  it("shows one, two, or four panes and keeps the rest", () => {
    const layout = defaultLayout(12);
    expect(visibleCount("single")).toBe(1);
    expect(visibleCount("columns")).toBe(2);
    expect(visibleCount("rows")).toBe(2);
    expect(visibleCount("grid")).toBe(4);
    expect(visiblePanes(layout)).toHaveLength(1);
    const grid = withPreset(layout, "grid");
    expect(visiblePanes(grid)).toHaveLength(4);
    expect(visiblePanes(withPreset(grid, "single"))[0]?.id).toBe("p0");
  });

  it("clamps focus when the arrangement shrinks", () => {
    const layout = withFocus(withPreset(defaultLayout(12), "grid"), 3);
    expect(focusedPane(layout).id).toBe("p3");
    expect(focusedPane(withPreset(layout, "single")).id).toBe("p0");
  });

  it("reads the old views query", () => {
    expect(presetFromParams(new URLSearchParams("views=split"))).toBe("columns");
    expect(presetFromParams(new URLSearchParams("views=3d"))).toBe("single");
    expect(presetFromParams(new URLSearchParams("layout=grid&views=3d"))).toBe("grid");
  });

  it("changes one pane's kind without touching the others", () => {
    const layout = withPane(defaultLayout(6), 1, { kind: "3d", time: 0 });
    expect(layout.panes[1]).toMatchObject({ kind: "3d", time: 0 });
    expect(layout.panes[0]).toMatchObject({ kind: "3d", time: 6 });
  });
});
