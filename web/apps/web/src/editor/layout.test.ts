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
  withShow,
  withTime,
} from "./layout.ts";
import { defaultShow, readShow } from "./view-options.ts";

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

  it("keeps each pane's overlays apart", () => {
    const layout = withShow(withPreset(defaultLayout(12), "columns"), 1, "compass", false);
    expect(layout.panes[1]?.show.compass).toBe(false);
    expect(layout.panes[0]?.show.compass).toBe(true);
    expect(withShow(layout, 1, "compass", false)).toBe(layout);
  });

  it("reads saved overlays over the defaults", () => {
    expect(readShow({ grid: false, slice: "yes", bogus: true })).toEqual({
      ...defaultShow(),
      grid: false,
    });
    expect(readShow(null)).toEqual(defaultShow());
  });

  it("sets the time on the 3D panes and leaves a flat one", () => {
    const layout = withPane(defaultLayout(12), 1, { kind: "2d" });
    const next = withTime(layout, 18);
    expect(next.panes[0]?.time).toBe(18);
    expect(next.panes[1]).toMatchObject({ kind: "2d", time: 12 });
    expect(next.panes[2]?.time).toBe(18);
    expect(withTime(next, 18)).toBe(next);
  });

  it("changes one pane's kind without touching the others", () => {
    const layout = withPane(defaultLayout(6), 1, { kind: "3d", time: 0 });
    expect(layout.panes[1]).toMatchObject({ kind: "3d", time: 0 });
    expect(layout.panes[0]).toMatchObject({ kind: "3d", time: 6 });
  });
});
