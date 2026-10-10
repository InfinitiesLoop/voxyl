import { describe, expect, it } from "vitest";
import { callUiTool, type UiHost, type ViewSnap } from "./ui-tools.ts";

function host(): UiHost & {
  frames: unknown[];
  cut: unknown;
  bar: (string | null)[];
  toolName: string;
} {
  const views: ViewSnap[] = [
    {
      id: "p0",
      kind: "3d",
      focused: true,
      view: {
        mode: "textured",
        shading: "app",
        projection: "perspective",
        background: "sky",
        orbit: "off",
      },
      camera: { position: [1, 2, 3], yaw: 0, pitch: 0 },
    },
    { id: "p1", kind: "2d", focused: false },
  ];
  const state = {
    frames: [] as unknown[],
    cut: null as unknown,
    bar: [null, null, null, null, null, null, null, null, null] as (string | null)[],
    selected: 0,
    toolName: "build",
    brush: 1,
  };
  const api: UiHost = {
    views: () => views,
    setRender(id, patch) {
      const view = views.find((v) => v.id === id);
      if (view?.view) Object.assign(view.view, patch);
    },
    async frame(id, box, camera) {
      state.frames.push({ id, box, camera });
    },
    cutaway: () => null,
    applyCutaway(action) {
      state.cut = action;
      if (action.clear) return null;
      const box = action.box ?? { min: [0, 0, 0], max: [1, 1, 1] };
      return { ...box, enabled: action.enabled !== false };
    },
    hotbar: () => ({ slots: state.bar, selected: state.selected }),
    setHotbar(slots, selected) {
      if (slots) state.bar = Array.from({ length: 9 }, (_, i) => slots[i] ?? null);
      if (selected !== undefined) state.selected = selected;
    },
    tool: () => ({ tool: state.toolName, brush: state.brush }),
    setTool(tool, brush) {
      state.toolName = tool;
      if (brush !== undefined) state.brush = brush;
    },
  };
  return Object.assign(api, state);
}

describe("view tools", () => {
  it("lists panes and aims the focused 3D view", async () => {
    const ui = host();
    const listed = await callUiTool(ui, "view_list", {});
    expect(listed.ok).toBe(true);
    const aimed = await callUiTool(ui, "view_set", {
      render: { mode: "intent", orbit: "slow" },
      camera: { frame: "all", from: "north", elevation: "high" },
    });
    expect(aimed.ok).toBe(true);
    expect(ui.frames).toEqual([{ id: "p0", box: "all", camera: { bearing: 0, elevation: 50 } }]);
    const twoD = await callUiTool(ui, "view_set", { view: "p1", camera: { from: "se" } });
    expect(twoD.ok).toBe(false);
  });

  it("sets the hotbar, the tool and the cutaway", async () => {
    const ui = host();
    const bar = await callUiTool(ui, "hotbar_set", { slots: ["Wall", null, "Trim"], select: 3 });
    expect(bar).toMatchObject({
      ok: true,
      hotbar: { slots: ["Wall", null, "Trim", null, null, null, null, null, null], selected: 3 },
    });
    const tool = await callUiTool(ui, "tool_set", { tool: "select", brush: 5 });
    expect(tool).toMatchObject({ ok: true, tool: "select", brush: 5 });
    const cut = await callUiTool(ui, "cutaway", { box: [0, 0, 0, 2, 1, 3] });
    expect(cut).toMatchObject({
      ok: true,
      cutaway: { min: [0, 0, 0], max: [2, 1, 3], enabled: true },
    });
    expect((await callUiTool(ui, "tool_set", { tool: "hammer" })).ok).toBe(false);
  });
});
