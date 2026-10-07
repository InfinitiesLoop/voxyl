// The one list of what a pane can show or hide. A pane's bar builds its Show menu from it,
// the layout remembers each pane's choices, and the engine and 2D view read them. Adding an
// overlay is one entry here plus the code that draws it. These are lens settings only: none
// of them touches the project (CLAUDE.md principle 2).

export type PaneKind = "3d" | "2d";

export type ShowId = "grid" | "slice" | "compass" | "cameras";

export interface ShowOption {
  readonly id: ShowId;
  readonly label: string;
  readonly title: string;
  /** The kinds of pane that draw it. Other kinds keep the choice but don't offer it. */
  readonly kinds: readonly PaneKind[];
  readonly default: boolean;
}

export const SHOW_OPTIONS: readonly ShowOption[] = [
  {
    id: "grid",
    label: "Ground grid",
    title: "Cell lines on the ground, with a major line every 16",
    kinds: ["3d"],
    default: true,
  },
  {
    id: "slice",
    label: "2D slice",
    title: "Where the active 2D view cuts through the world",
    kinds: ["3d"],
    default: true,
  },
  {
    id: "cameras",
    label: "3D cameras",
    title: "Where each 3D view stands and which way it looks",
    kinds: ["2d"],
    default: true,
  },
  {
    id: "compass",
    label: "Compass",
    title: "Which way the project's north is",
    kinds: ["3d", "2d"],
    default: true,
  },
];

export type ShowState = Readonly<Record<ShowId, boolean>>;

export function defaultShow(): ShowState {
  return Object.fromEntries(SHOW_OPTIONS.map((o) => [o.id, o.default])) as Record<ShowId, boolean>;
}

/** Saved choices over the defaults; anything unknown or missing keeps its default. */
export function readShow(saved: unknown): ShowState {
  const show = { ...defaultShow() } as Record<ShowId, boolean>;
  if (!saved || typeof saved !== "object") return show;
  for (const option of SHOW_OPTIONS) {
    const value = (saved as Record<string, unknown>)[option.id];
    if (typeof value === "boolean") show[option.id] = value;
  }
  return show;
}

export function optionsFor(kind: PaneKind): readonly ShowOption[] {
  return SHOW_OPTIONS.filter((option) => option.kinds.includes(kind));
}
