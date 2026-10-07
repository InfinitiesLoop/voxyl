import { type ReactNode, useEffect, useRef, useState } from "react";
import { Compass } from "../editor/Compass.tsx";
import { compassPoint } from "../editor/compass.ts";
import { BarSpacer, blurAfter, ShowMenu, ViewBar } from "../editor/ViewBar.tsx";
import type { ShowId, ShowState } from "../editor/view-options.ts";
import type { Engine } from "../scene/Engine.ts";
import type { WorldInfo } from "../worlds.ts";
import { GridView, type GridViewState } from "./GridView.ts";
import { orientationFor, type SliceAxis } from "./plane.ts";

const AXES: readonly { axis: SliceAxis; label: string; depth: string }[] = [
  { axis: 1, label: "Plan", depth: "Layer y" },
  { axis: 0, label: "Cut across x", depth: "At x" },
  { axis: 2, label: "Cut across z", depth: "At z" },
];

/**
 * A 2D pane: its bar (the kind switch, which slice, the layer, overlays, and what is under
 * the pointer) over a GridView canvas. React draws only the chrome; GridView draws the slice
 * from the world worker's cells. The active 2D pane shows its slice in the 3D views.
 */
export function GridPane({
  engine,
  info,
  leading,
  show,
  onShow,
  onFocus,
  active,
}: {
  engine: Engine;
  info: WorldInfo | null;
  /** What the bar starts with (the kind switch). */
  leading: ReactNode;
  show: ShowState;
  onShow: (id: ShowId, on: boolean) => void;
  onFocus: () => void;
  /** This pane's slice is the one the 3D views draw. */
  active: boolean;
}) {
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

  useEffect(() => {
    viewRef.current?.setActive(active);
  }, [active]);

  useEffect(() => {
    viewRef.current?.setCameras(show.cameras);
  }, [show.cameras]);

  const axis = AXES.find((a) => a.axis === state?.axis) ?? AXES[0];
  const hover = state?.hover;
  const depth = state?.depth ?? 0;
  const step = (delta: number) => viewRef.current?.setDepth(depth + delta);
  return (
    <>
      <ViewBar onFocus={onFocus}>
        {leading}
        <select
          className="bar-select"
          title="Which slice: a plan of one layer, or a cut across x or z"
          value={state?.axis ?? 1}
          onChange={(e) => {
            viewRef.current?.setAxis(Number(e.target.value) as SliceAxis);
            e.currentTarget.blur();
          }}
        >
          {AXES.map((a) => (
            <option key={a.axis} value={a.axis}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="bar-stepper">
          {axis?.depth}
          <button
            type="button"
            title="Down a layer: [ or Page Down"
            onClick={blurAfter(() => step(-1))}
          >
            −
          </button>
          <input
            type="number"
            aria-label={axis?.depth}
            value={depth}
            onChange={(e) => viewRef.current?.setDepth(Number(e.target.value))}
          />
          <button type="button" title="Up a layer: ] or Page Up" onClick={blurAfter(() => step(1))}>
            +
          </button>
        </span>
        <ShowMenu kind="2d" show={show} onShow={onShow} />
        <BarSpacer />
        <span className="bar-readout">
          {hover ? `${hover.at.join(", ")} · ${hover.what}` : "Flat, no lighting"}
        </span>
      </ViewBar>
      <div className="pane-fill" onPointerDown={onFocus}>
        <div ref={hostRef} className="grid-host" />
        {show.compass && info && (
          <div className="pane-corner">
            {(state?.axis ?? 1) === 1 ? (
              // A plan always has the real north at the top.
              <Compass heading={() => 0} />
            ) : (
              <CutCompass axis={state?.axis ?? 0} info={info} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** A cut stands up, so a disc means nothing: it names the directions to the left and right. */
function CutCompass({ axis, info }: { axis: SliceAxis; info: WorldInfo }) {
  const right = orientationFor(axis, info.north).right;
  // Screen right in the project's axes: u is z across x (axis 0), x across z (axis 2).
  const dx = axis === 2 ? right.sign : 0;
  const dz = axis === 0 ? right.sign : 0;
  return (
    <span className="cut-compass" title="The real directions to the left and right">
      {compassPoint(-dx, -dz, info.north)} ◂ ▸ {compassPoint(dx, dz, info.north)}
    </span>
  );
}
