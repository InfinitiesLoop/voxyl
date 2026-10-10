// The editor behind the view tools: panes, the camera, the cutaway, the hotbar, the tool.

import { ToolError } from "@voxyl/tools";
import { focusedIndex, type LayoutState, visiblePanes, withView } from "../editor/layout.ts";
import type { Engine } from "../scene/Engine.ts";
import type { CellBox } from "../scene/framing.ts";
import type { SemanticInfo } from "../world/editing.ts";
import type { UiHost, ViewSnap } from "./ui-tools.ts";

export function createUiHost(
  engine: Engine,
  layout: () => LayoutState,
  setLayout: (next: LayoutState) => void,
): UiHost {
  const snaps = (): ViewSnap[] => {
    const current = layout();
    const focus = focusedIndex(current);
    return visiblePanes(current).map((pane, index) => {
      const camera = pane.kind === "3d" ? engine.viewCamera(pane.id) : null;
      return {
        id: pane.id,
        kind: pane.kind,
        focused: index === focus,
        ...(pane.kind === "3d" && { view: pane.view }),
        ...(camera && { camera }),
      };
    });
  };
  return {
    views: snaps,
    setRender(id, patch) {
      const current = layout();
      const index = current.panes.findIndex((pane) => pane.id === id);
      if (index < 0) throw new ToolError("no_view", `No view "${id}".`);
      setLayout(withView(current, index, patch));
    },
    async frame(id, which, camera) {
      const box = await resolveBox(engine, which);
      const moved = engine.frameBox(id, box, camera.bearing, camera.elevation, camera.fov);
      if (!moved) throw new ToolError("no_view", "That 3D view isn't on screen yet.");
    },
    cutaway() {
      const { box, on } = engine.cutaway.get();
      return box ? { min: box.min, max: box.max, enabled: on } : null;
    },
    applyCutaway(action) {
      if (action.clear) {
        engine.setCutaway(null);
        return null;
      }
      const enabled = action.enabled !== false;
      if (action.selection) {
        const bounds = engine.selection.get().bounds;
        if (!bounds) throw new ToolError("bad_region", "Nothing is selected.");
        const box = {
          min: [bounds[0], bounds[1], bounds[2]] as [number, number, number],
          max: [bounds[3], bounds[4], bounds[5]] as [number, number, number],
        };
        engine.setCutaway(box, enabled);
        return { ...box, enabled };
      }
      if (action.box) {
        const box = {
          min: action.box.min as [number, number, number],
          max: action.box.max as [number, number, number],
        };
        engine.setCutaway(box, enabled);
        return { ...box, enabled };
      }
      const current = engine.cutaway.get();
      if (!current.box)
        throw new ToolError("no_cutaway", "There's no cutaway to switch. Give a box.");
      engine.setCutaway(current.box, action.enabled ?? current.on);
      return { min: current.box.min, max: current.box.max, enabled: action.enabled ?? current.on };
    },
    hotbar() {
      const { slots, selected } = engine.hotbar.state.get();
      return { slots: slots.map((slot) => slot?.name ?? null), selected };
    },
    setHotbar(slots, selected) {
      const current = engine.hotbar.state.get();
      const nextSlots = slots
        ? Array.from({ length: 9 }, (_, i) => {
            const name = slots[i];
            if (name === undefined || name === null) return null;
            return findSemantic(engine.palettes.get(), name);
          })
        : current.slots;
      const nextSelected =
        selected === undefined ? current.selected : Math.max(0, Math.min(8, selected));
      engine.hotbar.state.set({ slots: nextSlots, selected: nextSelected });
    },
    tool: () => ({ tool: engine.tool.get(), brush: engine.brush.get() }),
    setTool(tool, brush) {
      engine.setTool(tool);
      if (brush !== undefined) engine.setBrush(brush);
    },
  };
}

async function resolveBox(
  engine: Engine,
  which: "all" | "selection" | readonly [number, number, number, number, number, number],
): Promise<CellBox> {
  if (which === "selection") {
    const bounds = engine.selection.get().bounds;
    if (!bounds) throw new ToolError("bad_region", "Nothing is selected.");
    return {
      min: [bounds[0], bounds[1], bounds[2]],
      max: [bounds[3] + 1, bounds[4] + 1, bounds[5] + 1],
    };
  }
  if (which === "all") {
    const bounds = await engine.worldBounds();
    if (!bounds) throw new ToolError("bad_region", "The build is empty.");
    return bounds;
  }
  const [x0, y0, z0, x1, y1, z1] = which;
  return {
    min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
    max: [Math.max(x0, x1) + 1, Math.max(y0, y1) + 1, Math.max(z0, z1) + 1],
  };
}

function findSemantic(
  palettes: readonly { name: string; semantics: readonly SemanticInfo[] }[],
  name: string,
): SemanticInfo {
  const wanted = name.trim();
  const all = palettes.flatMap((palette) =>
    palette.semantics.map((info) => ({ palette: palette.name, info })),
  );
  const exact = all.filter((entry) => entry.info.name === wanted);
  const found =
    exact.length > 0
      ? exact
      : all.filter((entry) => entry.info.name.toLowerCase() === wanted.toLowerCase());
  if (found.length === 1) return found[0]?.info as SemanticInfo;
  if (found.length > 1) {
    throw new ToolError(
      "ambiguous",
      `${found.length} semantics are named "${wanted}": ${found.map((e) => `${e.palette}: ${e.info.name}`).join(", ")}.`,
    );
  }
  throw new ToolError("not_found", `No semantic named "${wanted}" in the open project.`, {
    kind: "semantic",
    query: wanted,
  });
}
