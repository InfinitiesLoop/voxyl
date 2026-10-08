import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CameraPreset, Engine, ViewFrame } from "../scene/Engine.ts";
import { GridPane } from "../views/GridPane.tsx";
import type { WorldInfo } from "../worlds.ts";
import { Compass } from "./Compass.tsx";
import { northHeading } from "./compass.ts";
import {
  focusedIndex,
  type LayoutState,
  type Pane,
  visiblePanes,
  withFocus,
  withPane,
  withPreset,
  withShow,
  withView,
} from "./layout.ts";
import { timeLabel } from "./TopBar.tsx";
import { useStore } from "./useStore.ts";
import {
  BarMenu,
  BarSpacer,
  blurAfter,
  ChoiceRow,
  KindSwitch,
  ShowMenu,
  ViewBar,
} from "./ViewBar.tsx";
import {
  BACKGROUNDS,
  ORBITS,
  PROJECTIONS,
  RENDER_MODES,
  SHADINGS,
  type ViewSettings,
} from "./view-options.ts";

/** Times of day a click away, as in Minecraft's /time set. */
const TIMES: readonly { label: string; hours: number }[] = [
  { label: "Sunrise", hours: 6 },
  { label: "Noon", hours: 12 },
  { label: "Sunset", hours: 18 },
  { label: "Midnight", hours: 0 },
];

/**
 * The workspace grid. Each pane is a 3D view (its own camera and time of day) or a flat 2D
 * slice. The canvas underneath draws the 3D panes; this layer is the chrome and the 2D views.
 */
export function Panes({
  engine,
  info,
  layout,
  onLayout,
  locked,
}: {
  engine: Engine;
  info: WorldInfo | null;
  layout: LayoutState;
  onLayout: (layout: LayoutState) => void;
  locked: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const panes = useMemo(() => visiblePanes(layout), [layout]);
  const focus = focusedIndex(layout);

  // Tab while flying retargets the focused 2D pane, or the one focused last, or the first.
  // The amber slice in the 3D views is only that pane while it is the one you're in.
  const last2d = useRef<string | null>(null);
  const focused = panes[focus];
  if (focused?.kind === "2d") last2d.current = focused.id;
  const flat = panes.filter((pane) => pane.kind === "2d");
  const active2d = flat.find((pane) => pane.id === last2d.current)?.id ?? flat[0]?.id ?? null;
  const guide2d = focused?.kind === "2d" ? focused.id : null;

  // A slice request with no 2D view on screen: the next pane over becomes one.
  const request = useStore(engine.sliceRequest);
  const handled = useRef(0);
  useEffect(() => {
    if (!request || request.n === handled.current) return;
    handled.current = request.n;
    if (visiblePanes(layout).some((pane) => pane.kind === "2d")) return;
    let next = layout.preset === "single" ? withPreset(layout, "columns") : layout;
    const target = visiblePanes(next).findIndex((_, i) => i !== focusedIndex(next));
    if (target >= 0) next = withPane(next, target, { kind: "2d" });
    onLayout(next);
  }, [request, layout, onLayout]);

  useEffect(() => {
    engine.onFocusView = (id) => {
      const index = visiblePanes(layout).findIndex((pane) => pane.id === id);
      if (index >= 0) onLayout(withFocus(layout, index));
    };
    engine.onOrbitStop = (id) => {
      const index = layout.panes.findIndex((pane) => pane.id === id);
      if (index >= 0) onLayout(withView(layout, index, { orbit: "off" }));
    };
    return () => {
      engine.onFocusView = null;
      engine.onOrbitStop = null;
    };
  }, [engine, layout, onLayout]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const publish = () => {
      const origin = host.getBoundingClientRect();
      const frames: ViewFrame[] = [];
      for (const [index, pane] of panes.entries()) {
        if (pane.kind !== "3d") continue;
        const el = bodies.current.get(pane.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        frames.push({
          id: pane.id,
          time: pane.time,
          focused: index === focus,
          grid: pane.show.grid,
          slice: pane.show.slice,
          view: pane.view,
          x: rect.left - origin.left,
          y: rect.top - origin.top,
          width: rect.width,
          height: rect.height,
        });
      }
      engine.setFrames(frames);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(host);
    for (const el of bodies.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [engine, panes, focus]);

  return (
    <div ref={hostRef} className={`layout layout-${layout.preset}`}>
      {panes.map((pane, index) => {
        const onFocus = () => onLayout(withFocus(layout, index));
        const kindSwitch = (
          <KindSwitch
            kind={pane.kind}
            onChange={(kind) => onLayout(withPane(withFocus(layout, index), index, { kind }))}
          />
        );
        const onShow = (id: Parameters<typeof withShow>[2], on: boolean) =>
          onLayout(withShow(layout, index, id, on));
        return (
          <section key={pane.id} className={index === focus ? "pane focused" : "pane"}>
            {pane.kind === "2d" ? (
              <GridPane
                engine={engine}
                info={info}
                leading={kindSwitch}
                show={pane.show}
                onShow={onShow}
                onFocus={onFocus}
                active={pane.id === active2d}
                guide={pane.id === guide2d}
              />
            ) : (
              <>
                <ViewBar onFocus={onFocus}>
                  {kindSwitch}
                  <TimeMenu
                    pane={pane}
                    onTime={(time) => onLayout(withPane(layout, index, { time }))}
                  />
                  <RenderMenu
                    view={pane.view}
                    onView={(patch) => onLayout(withView(layout, index, patch))}
                  />
                  <CameraMenu
                    engine={engine}
                    paneId={pane.id}
                    view={pane.view}
                    onView={(patch) => onLayout(withView(layout, index, patch))}
                  />
                  <ShowMenu kind="3d" show={pane.show} onShow={onShow} />
                  <BarSpacer />
                </ViewBar>
                <div
                  className="pane-body"
                  ref={(el) => {
                    if (el) bodies.current.set(pane.id, el);
                    else bodies.current.delete(pane.id);
                  }}
                >
                  {index === focus && locked && <div className="crosshair" />}
                  {pane.show.compass && (
                    <div className="pane-corner">
                      <Compass
                        heading={() => {
                          const yaw = engine.viewYaw(pane.id);
                          return yaw === null
                            ? null
                            : { angle: northHeading(yaw, info?.north ?? "north") };
                        }}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** The pane's time of day: a slider and the four named times. */
function TimeMenu({ pane, onTime }: { pane: Pane; onTime: (hours: number) => void }) {
  const night = pane.time < 6 || pane.time >= 18;
  return (
    <BarMenu
      label={
        <>
          <span aria-hidden>{night ? "☾" : "☀"}</span> {timeLabel(pane.time)}
        </>
      }
      title="Time of day in this view"
    >
      <label className="bar-range">
        Time of day {timeLabel(pane.time)}
        <input
          type="range"
          min={0}
          max={24}
          step={0.25}
          aria-label="Time of day"
          value={pane.time}
          onChange={(event) => onTime(Number(event.target.value))}
        />
      </label>
      <span className="bar-choices">
        {TIMES.map((t) => (
          <button
            key={t.label}
            type="button"
            aria-pressed={pane.time === t.hours}
            onClick={blurAfter(() => onTime(t.hours))}
          >
            {t.label}
          </button>
        ))}
      </span>
    </BarMenu>
  );
}

const PRESETS: readonly { preset: CameraPreset; label: string; title: string }[] = [
  { preset: "overview", label: "Overview", title: "Back to where the project opened" },
  { preset: "north", label: "From north", title: "Frame the build from the real north" },
  { preset: "east", label: "From east", title: "Frame the build from the real east" },
  { preset: "south", label: "From south", title: "Frame the build from the real south" },
  { preset: "west", label: "From west", title: "Frame the build from the real west" },
  { preset: "top", label: "Top", title: "Straight down on the build" },
  { preset: "iso", label: "Iso", title: "From the nearest corner, at the isometric angle" },
  { preset: "selection", label: "Selection", title: "Frame the selection" },
];

/** The pane's camera: presets, orbit, projection and flying speed. */
function CameraMenu({
  engine,
  paneId,
  view,
  onView,
}: {
  engine: Engine;
  paneId: string;
  view: ViewSettings;
  onView: (patch: Partial<ViewSettings>) => void;
}) {
  const speed = useStore(engine.speed);
  const selection = useStore(engine.selection);
  return (
    <BarMenu label="Camera" title="Camera presets, orbit, projection and fly speed">
      <span className="bar-choices">
        {PRESETS.map((p) => (
          <button
            key={p.preset}
            type="button"
            title={p.title}
            disabled={p.preset === "selection" && !selection.bounds}
            onClick={blurAfter(() => void engine.frameView(paneId, p.preset))}
          >
            {p.label}
          </button>
        ))}
      </span>
      <ChoiceRow
        label="Orbit"
        choices={ORBITS}
        value={view.orbit}
        onChange={(orbit) => onView({ orbit })}
      />
      <ChoiceRow
        label="Projection"
        choices={PROJECTIONS}
        value={view.projection}
        onChange={(projection) => onView({ projection })}
      />
      <label className="bar-range">
        Fly speed {Math.round(speed)} cells a second (= and -)
        <input
          type="range"
          min={Math.log(2)}
          max={Math.log(400)}
          step={0.01}
          value={Math.log(speed)}
          onChange={(e) => engine.setSpeed(Math.exp(Number(e.target.value)))}
        />
      </label>
    </BarMenu>
  );
}

/** How the pane draws: render mode, shading and background. */
function RenderMenu({
  view,
  onView,
}: {
  view: ViewSettings;
  onView: (patch: Partial<ViewSettings>) => void;
}) {
  const mode = RENDER_MODES.find((m) => m.value === view.mode);
  return (
    <BarMenu label={mode?.label ?? "Render"} title="How this view draws the build">
      <ChoiceRow
        label="Render"
        choices={RENDER_MODES}
        value={view.mode}
        onChange={(m) => onView({ mode: m })}
      />
      <ChoiceRow
        label="Shading"
        choices={SHADINGS}
        value={view.shading}
        onChange={(shading) => onView({ shading })}
      />
      <ChoiceRow
        label="Background"
        choices={BACKGROUNDS}
        value={view.background}
        onChange={(background) => onView({ background })}
      />
    </BarMenu>
  );
}
