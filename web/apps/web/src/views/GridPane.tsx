import { useEffect, useRef, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { WorldInfo } from "../worlds.ts";
import { GridView, type GridViewState } from "./GridView.ts";
import type { SliceAxis } from "./plane.ts";

const AXES: readonly { axis: SliceAxis; label: string; depth: string }[] = [
  { axis: 1, label: "Plan", depth: "Layer y" },
  { axis: 0, label: "Cut across x", depth: "At x" },
  { axis: 2, label: "Cut across z", depth: "At z" },
];

/**
 * The 2D view's pane: a GridView canvas and its toolbar. React draws only the toolbar; the
 * slice is drawn by GridView from the world worker's cells.
 */
export function GridPane({ engine, info }: { engine: Engine; info: WorldInfo | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GridView | null>(null);
  const [state, setState] = useState<GridViewState | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new GridView(host, engine, setState);
    viewRef.current = view;
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [engine]);

  // A newly opened world: look at its middle, one layer above its base.
  useEffect(() => {
    if (!info) return;
    const [x, y, z] = info.center;
    viewRef.current?.focus([x, Math.floor(y) + 1, z], info.extent, info.north, info.grid);
  }, [info]);

  const axis = AXES.find((a) => a.axis === state?.axis) ?? AXES[0];
  const hover = state?.hover;
  return (
    <div className="grid-pane">
      <div className="grid-toolbar">
        <select
          value={state?.axis ?? 1}
          onChange={(e) => viewRef.current?.setAxis(Number(e.target.value) as SliceAxis)}
        >
          {AXES.map((a) => (
            <option key={a.axis} value={a.axis}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="grid-depth">
          {axis?.depth}
          <button
            type="button"
            title="Down a layer: [ or Page Down"
            onClick={() => viewRef.current?.setDepth((state?.depth ?? 0) - 1)}
          >
            −
          </button>
          <input
            type="number"
            value={state?.depth ?? 0}
            onChange={(e) => viewRef.current?.setDepth(Number(e.target.value))}
          />
          <button
            type="button"
            title="Up a layer: ] or Page Up"
            onClick={() => viewRef.current?.setDepth((state?.depth ?? 0) + 1)}
          >
            +
          </button>
        </span>
        <span className="grid-hover">{hover ? `${hover.at.join(", ")} · ${hover.what}` : ""}</span>
      </div>
      <div ref={hostRef} className="grid-host" />
    </div>
  );
}
