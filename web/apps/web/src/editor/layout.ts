// How the workspace is split. Editor state, not part of the project: a view is a lens.
// Four panes are always remembered; a preset shows the first one, two, or all four, so
// switching back to a grid restores the views you had.

import { wrapHours } from "../scene/sky-model.ts";
import {
  defaultShow,
  defaultView,
  type PaneKind,
  readShow,
  readView,
  type ShowId,
  type ShowState,
  type ViewSettings,
} from "./view-options.ts";

export type { PaneKind } from "./view-options.ts";

export type LayoutPreset = "single" | "columns" | "rows" | "grid";

export interface Pane {
  readonly id: string;
  readonly kind: PaneKind;
  /** Time of day in hours. A 2D pane draws flat and ignores it. */
  readonly time: number;
  /** Which overlays this pane draws (view-options.ts). */
  readonly show: ShowState;
  /** How a 3D pane draws: render mode, shading, projection, background, orbit. */
  readonly view: ViewSettings;
}

export interface LayoutState {
  readonly preset: LayoutPreset;
  readonly panes: readonly [Pane, Pane, Pane, Pane];
  /** Index among the panes the preset is showing. */
  readonly focus: number;
}

const STORAGE_KEY = "voxyl.layout";

export function visibleCount(preset: LayoutPreset): number {
  if (preset === "single") return 1;
  if (preset === "grid") return 4;
  return 2;
}

export function isPreset(value: unknown): value is LayoutPreset {
  return value === "single" || value === "columns" || value === "rows" || value === "grid";
}

export function defaultLayout(time: number): LayoutState {
  const hours = wrapHours(time);
  const pane = (id: string, kind: PaneKind): Pane => ({
    id,
    kind,
    time: hours,
    show: defaultShow(),
    view: defaultView(),
  });
  return {
    preset: "single",
    panes: [pane("p0", "3d"), pane("p1", "2d"), pane("p2", "3d"), pane("p3", "3d")],
    focus: 0,
  };
}

export function visiblePanes(layout: LayoutState): readonly Pane[] {
  return layout.panes.slice(0, visibleCount(layout.preset));
}

export function focusedIndex(layout: LayoutState): number {
  return Math.min(Math.max(0, layout.focus), visibleCount(layout.preset) - 1);
}

export function focusedPane(layout: LayoutState): Pane {
  return layout.panes[focusedIndex(layout)] ?? layout.panes[0];
}

export function withPreset(layout: LayoutState, preset: LayoutPreset): LayoutState {
  if (layout.preset === preset) return layout;
  return { ...layout, preset, focus: Math.min(layout.focus, visibleCount(preset) - 1) };
}

export function withFocus(layout: LayoutState, focus: number): LayoutState {
  const count = visibleCount(layout.preset);
  if (focus < 0 || focus >= count || focus === layout.focus) return layout;
  return { ...layout, focus };
}

export function withPane(
  layout: LayoutState,
  index: number,
  patch: Partial<Pick<Pane, "kind" | "time" | "show" | "view">>,
): LayoutState {
  if (index < 0 || index >= layout.panes.length) return layout;
  const panes = layout.panes.map((pane, i) =>
    i === index ? { ...pane, ...patch } : pane,
  ) as unknown as LayoutState["panes"];
  return { ...layout, panes };
}

/** Turns one of a pane's overlays on or off. */
export function withShow(layout: LayoutState, index: number, id: ShowId, on: boolean): LayoutState {
  const pane = layout.panes[index];
  if (!pane || pane.show[id] === on) return layout;
  return withPane(layout, index, { show: { ...pane.show, [id]: on } });
}

/** Changes some of a pane's view settings. */
export function withView(
  layout: LayoutState,
  index: number,
  patch: Partial<ViewSettings>,
): LayoutState {
  const pane = layout.panes[index];
  if (!pane) return layout;
  return withPane(layout, index, { view: { ...pane.view, ...patch } });
}

/** The arrangement a link asked for, if it named one. */
export function presetFromParams(params: URLSearchParams): LayoutPreset | null {
  const named = params.get("layout");
  if (isPreset(named)) return named;
  const views = params.get("views");
  if (views === "split") return "columns";
  if (views === "3d") return "single";
  if (isPreset(views)) return views;
  return null;
}

export function readLayout(time: number, params: URLSearchParams): LayoutState {
  let layout = loadLayout(time) ?? defaultLayout(time);
  const preset = presetFromParams(params);
  if (preset) layout = withPreset(layout, preset);
  // The old "3D beside 2D" link. A saved second pane might have been 3D.
  if (!params.get("layout") && params.get("views") === "split") {
    layout = withPane(layout, 1, { kind: "2d" });
  }
  if (params.has("time")) {
    const index = focusedIndex(layout);
    const pane = layout.panes[index];
    if (pane?.kind === "3d") layout = withPane(layout, index, { time: wrapHours(time) });
  }
  return layout;
}

export function saveLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        preset: layout.preset,
        focus: layout.focus,
        panes: layout.panes.map(({ kind, time, show, view }) => ({ kind, time, show, view })),
      }),
    );
  } catch {
    // The arrangement still holds for this visit.
  }
}

function loadLayout(time: number): LayoutState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { preset?: unknown; focus?: unknown; panes?: unknown };
    const base = defaultLayout(time);
    if (!Array.isArray(record.panes)) return null;
    const savedPanes = record.panes as unknown[];
    const panes = base.panes.map((pane, i) => {
      const saved = savedPanes[i] as Record<string, unknown> | undefined;
      if (!saved) return pane;
      const kind: PaneKind = saved.kind === "2d" ? "2d" : "3d";
      const hours = Number(saved.time);
      return {
        id: pane.id,
        kind,
        time: Number.isFinite(hours) ? wrapHours(hours) : pane.time,
        show: readShow(saved.show),
        view: readView(saved.view),
      };
    }) as unknown as LayoutState["panes"];
    const preset = isPreset(record.preset) ? record.preset : "single";
    const focus = typeof record.focus === "number" ? record.focus : 0;
    return { preset, panes, focus: Math.min(Math.max(0, focus), visibleCount(preset) - 1) };
  } catch {
    return null;
  }
}
