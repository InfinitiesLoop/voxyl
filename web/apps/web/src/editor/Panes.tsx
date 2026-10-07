import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Engine, ViewFrame } from "../scene/Engine.ts";
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
  withShow,
} from "./layout.ts";
import { timeLabel } from "./TopBar.tsx";
import { BarMenu, BarSpacer, blurAfter, KindSwitch, ShowMenu, ViewBar } from "./ViewBar.tsx";

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

  // The 2D view the 3D panes show a slice guide for: the focused pane if it is 2D, else
  // the 2D pane focused last, else the first one.
  const last2d = useRef<string | null>(null);
  const focused = panes[focus];
  if (focused?.kind === "2d") last2d.current = focused.id;
  const flat = panes.filter((pane) => pane.kind === "2d");
  const active2d = flat.find((pane) => pane.id === last2d.current)?.id ?? flat[0]?.id ?? null;

  useEffect(() => {
    engine.onFocusView = (id) => {
      const index = visiblePanes(layout).findIndex((pane) => pane.id === id);
      if (index >= 0) onLayout(withFocus(layout, index));
    };
    return () => {
      engine.onFocusView = null;
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
              />
            ) : (
              <>
                <ViewBar onFocus={onFocus}>
                  {kindSwitch}
                  <TimeMenu
                    pane={pane}
                    onTime={(time) => onLayout(withPane(layout, index, { time }))}
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
                          return yaw === null ? null : northHeading(yaw, info?.north ?? "north");
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
