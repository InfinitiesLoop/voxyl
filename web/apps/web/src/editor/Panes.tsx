import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Engine, ViewFrame } from "../scene/Engine.ts";
import { GridPane } from "../views/GridPane.tsx";
import type { WorldInfo } from "../worlds.ts";
import { focusedIndex, type LayoutState, visiblePanes, withFocus, withPane } from "./layout.ts";
import { timeLabel } from "./TopBar.tsx";

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
      {panes.map((pane, index) => (
        <section key={pane.id} className={index === focus ? "pane focused" : "pane"}>
          <header className="pane-bar" onPointerDown={() => onLayout(withFocus(layout, index))}>
            <button
              type="button"
              aria-pressed={pane.kind === "3d"}
              title={pane.kind === "3d" ? "Switch to a flat 2D slice" : "Switch to a 3D view"}
              onClick={() =>
                onLayout(withPane(layout, index, { kind: pane.kind === "3d" ? "2d" : "3d" }))
              }
            >
              {pane.kind === "3d" ? "3D" : "2D"}
            </button>
            {pane.kind === "3d" ? (
              <label className="pane-time">
                {timeLabel(pane.time)}
                <input
                  type="range"
                  min={0}
                  max={24}
                  step={0.25}
                  aria-label="Time of day"
                  value={pane.time}
                  onPointerDown={() => onLayout(withFocus(layout, index))}
                  onChange={(event) =>
                    onLayout(withPane(layout, index, { time: Number(event.target.value) }))
                  }
                />
              </label>
            ) : (
              <span className="pane-note">Flat, no lighting</span>
            )}
          </header>
          {pane.kind === "2d" ? (
            <div className="pane-fill" onPointerDown={() => onLayout(withFocus(layout, index))}>
              <GridPane engine={engine} info={info} />
            </div>
          ) : (
            <div
              className="pane-body"
              ref={(el) => {
                if (el) bodies.current.set(pane.id, el);
                else bodies.current.delete(pane.id);
              }}
            >
              {index === focus && locked && <div className="crosshair" />}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
