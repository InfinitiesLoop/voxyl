import { type ReactNode, useEffect, useRef, useState } from "react";
import { Compass } from "../editor/Compass.tsx";
import { cutLabels, viewCompass } from "../editor/compass.ts";
import type { EditorTool } from "../editor/tool.ts";
import { useStore } from "../editor/useStore.ts";
import { BarMenu, BarSpacer, blurAfter, ChoiceRow, ShowMenu, ViewBar } from "../editor/ViewBar.tsx";
import type { ShowId, ShowState } from "../editor/view-options.ts";
import type { Engine } from "../scene/Engine.ts";
import type { WorldInfo } from "../worlds.ts";
import { type DrawMode, GridView, type GridViewState } from "./GridView.ts";
import { orientationFor, type SliceAxis, turnedOrientation } from "./plane.ts";

const AXES: readonly { axis: SliceAxis; label: string; depth: string }[] = [
  { axis: 1, label: "Plan", depth: "Layer y" },
  { axis: 0, label: "Cut across x", depth: "At x" },
  { axis: 2, label: "Cut across z", depth: "At z" },
];

/**
 * A 2D pane: its bar (the kind switch, which slice, the layer, overlays, and what is under
 * the pointer) over a GridView canvas. React draws only the chrome; GridView draws the slice
 * from the world worker's cells. While this pane is the focused one, the 3D views draw its slice.
 */
export function GridPane({
  engine,
  info,
  leading,
  show,
  onShow,
  onFocus,
  active,
  guide,
}: {
  engine: Engine;
  info: WorldInfo | null;
  /** What the bar starts with (the kind switch). */
  leading: ReactNode;
  show: ShowState;
  onShow: (id: ShowId, on: boolean) => void;
  onFocus: () => void;
  /** Tab while flying retargets this slice. */
  active: boolean;
  /** The 3D views draw this slice. Only while this pane is the focused one. */
  guide: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GridView | null>(null);
  const [state, setState] = useState<GridViewState | null>(null);

  /** The last slice request this view carried out (a new view has carried out none). */
  const applied = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new GridView(host, engine, setState);
    viewRef.current = view;
    applied.current = 0;
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [engine]);

  // A newly opened world: look at its middle, one layer above its base.
  useEffect(() => {
    if (!info) return;
    const [x, y, z] = info.center;
    // One layer above the base shows a building's ground floor; an empty build starts on layer 0.
    const layer = info.top === 0 ? 0 : Math.floor(y) + 1;
    viewRef.current?.focus([x, layer, z], info.extent, info.north, info.grid);
  }, [info]);

  useEffect(() => {
    viewRef.current?.setShowGuide(guide);
  }, [guide]);

  useEffect(() => {
    viewRef.current?.setCameras(show.cameras);
  }, [show.cameras]);

  // Tab while flying (or 3D aim): the active 2D view slices through the aimed cell.
  const request = useStore(engine.sliceRequest);
  useEffect(() => {
    const view = viewRef.current;
    if (!active || !request || !view || request.n === applied.current) return;
    applied.current = request.n;
    view.sliceThrough(request.cell, request.turn ? nextAxis(view.state.axis) : undefined);
  }, [active, request]);

  const axis = AXES.find((a) => a.axis === state?.axis) ?? AXES[0];
  const hover = state?.hover;
  const tool = useStore(engine.tool);
  const [mode, setMode] = useState<DrawMode>("pencil");
  useEffect(() => {
    viewRef.current?.setDrawMode(mode);
  }, [mode]);
  const turns = state?.turns ?? 0;
  const mirror = state?.mirror ?? false;
  const setView = (t: number, m: boolean) => viewRef.current?.setView(t, m);
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
        <button
          type="button"
          title="Slice through the cell the 3D view aims at (Tab or Enter while flying; Shift turns the slice)"
          onClick={blurAfter(() => void engine.sliceAtAim(false))}
        >
          3D aim
        </button>
        <BarMenu
          label={DRAW_MODES.find((d) => d.value === mode)?.label ?? "Draw"}
          title="How Build draws here: left button draws, right button erases"
        >
          <ChoiceRow label="Draw" choices={DRAW_MODES} value={mode} onChange={setMode} />
        </BarMenu>
        <BarMenu label="View" title="Turn or mirror this view's picture">
          <span className="bar-choices">
            <button type="button" onClick={blurAfter(() => setView(turns + 3, mirror))}>
              Turn left
            </button>
            <button type="button" onClick={blurAfter(() => setView(turns + 1, mirror))}>
              Turn right
            </button>
            <button
              type="button"
              aria-pressed={mirror}
              title="Mirror left to right (F)"
              onClick={blurAfter(() => setView(turns, !mirror))}
            >
              Mirror
            </button>
            <button
              type="button"
              disabled={turns === 0 && !mirror}
              title="North up again, unmirrored"
              onClick={blurAfter(() => setView(0, false))}
            >
              Reset
            </button>
          </span>
        </BarMenu>
        <ShowMenu kind="2d" show={show} onShow={onShow} />
        <BarSpacer />
        <span className="bar-readout">
          {hover ? `${hover.at.join(", ")} · ${hover.what}` : flatHint(tool, mode)}
        </span>
      </ViewBar>
      <div className="pane-fill" onPointerDown={onFocus}>
        <div ref={hostRef} className="grid-host" />
        {show.compass && info && (
          <div className="pane-corner">
            {(state?.axis ?? 1) === 1 ? (
              <Compass
                heading={() => {
                  const o = turnedOrientation(
                    orientationFor(1, info.north),
                    state?.turns ?? 0,
                    state?.mirror ?? false,
                  );
                  const pose = viewCompass(o, 1, info.north);
                  return pose ? { angle: pose.heading, mirrored: pose.mirrored } : null;
                }}
              />
            ) : (
              <CutCompass axis={state?.axis ?? 0} turns={turns} mirror={mirror} info={info} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

const DRAW_MODES = [
  { value: "pencil", label: "Pencil", title: "Drag to draw cell by cell" },
  { value: "line", label: "Line", title: "Drag a straight line" },
  { value: "rect", label: "Rectangle", title: "Drag a filled rectangle" },
  {
    value: "fill",
    label: "Fill",
    title: "Fill the touching cells of the same kind on this layer, within the view",
  },
] as const satisfies readonly { value: DrawMode; label: string; title: string }[];

/** What the tool in hand does in a 2D view, when the pointer is over nothing. */
function flatHint(tool: EditorTool, mode: DrawMode): string {
  if (tool === "select")
    return "Right-click two corners (on any layers) · Shift+right-click: touching";
  if (tool === "exchange") return "Click swaps blocks in place · right-drag erases";
  const what = {
    pencil: "Drag draws",
    line: "Drag a line",
    rect: "Drag a rectangle",
    fill: "Click fills",
  }[mode];
  const note = tool === "wand" || tool === "column" ? " (the Wand and Build to me work in 3D)" : "";
  return `${what} · right button erases · middle-drag pans${note}`;
}

/** Plan, then a cut across x, then across z, and round again. */
function nextAxis(axis: SliceAxis): SliceAxis {
  return axis === 1 ? 0 : axis === 0 ? 2 : 1;
}

/** A cut stands up, so a disc means nothing: it names the directions to the left and right. */
function CutCompass({
  axis,
  turns,
  mirror,
  info,
}: {
  axis: SliceAxis;
  turns: number;
  mirror: boolean;
  info: WorldInfo;
}) {
  const labels = cutLabels(
    turnedOrientation(orientationFor(axis, info.north), turns, mirror),
    axis,
    info.north,
  );
  return (
    <span className="cut-compass" title="The real directions to the left and right">
      {labels.left} ◂ ▸ {labels.right}
    </span>
  );
}
