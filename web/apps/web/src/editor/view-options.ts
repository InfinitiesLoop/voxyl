// The one list of what a pane can show or hide. A pane's bar builds its Show menu from it,
// the layout remembers each pane's choices, and the engine and 2D view read them. Adding an
// overlay is one entry here plus the code that draws it. These are lens settings only: none
// of them touches the project (CLAUDE.md principle 2).

export type PaneKind = "3d" | "2d";

export type ShowId = "grid" | "slice" | "compass" | "cameras" | "details";

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
    title: "Where the focused 2D view cuts the world. Hidden while a 3D view is the one you're in",
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
  {
    id: "details",
    label: "Block details",
    title:
      "The semantic you are looking at, the palette it resolves to, the block it is assigned, the block library, and whether it glows",
    kinds: ["3d"],
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

// A 3D pane's view settings: one choice each, offered as menus in its bar. Like the overlays,
// they are lens settings only (CLAUDE.md principles 2 and 3): none touches the project, and
// every one of them reads the same cells and looks.

export interface ViewChoice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly title: string;
}

export const RENDER_MODES = [
  { value: "textured", label: "Textured", title: "Blocks as the palettes map them" },
  {
    value: "intent",
    label: "Intent",
    title: "Each semantic in its own flat colour: structure and intent, no materials",
  },
  { value: "clay", label: "Clay", title: "One neutral material: form and shadow only" },
  { value: "outline", label: "Outline", title: "Flat fill with dark edges: a line drawing" },
  { value: "xray", label: "X-ray", title: "Faces faint and every edge drawn: see inside" },
  {
    value: "wire",
    label: "Wire",
    title: "Edges only, through everything, coloured by semantic",
  },
] as const satisfies readonly ViewChoice<string>[];

export const SHADINGS = [
  { value: "app", label: "App", title: "The app's lighting: light and time of day" },
  {
    value: "studio",
    label: "Studio",
    title: "Bright, even light from every side: undersides read",
  },
  { value: "flat", label: "Flat", title: "No shading at all" },
] as const satisfies readonly ViewChoice<string>[];

export const PROJECTIONS = [
  { value: "perspective", label: "Perspective", title: "As the eye sees" },
  {
    value: "orthographic",
    label: "Orthographic",
    title: "No perspective: judge proportions and depth steps",
  },
] as const satisfies readonly ViewChoice<string>[];

export const BACKGROUNDS = [
  { value: "sky", label: "Sky", title: "The sky and the ground grid" },
  { value: "plain", label: "Plain", title: "A flat neutral backdrop" },
] as const satisfies readonly ViewChoice<string>[];

/** Orbit speeds in degrees per second; flying or dragging the view stops the orbit. */
export const ORBITS = [
  { value: "off", label: "Off", title: "The camera stays where you leave it", degrees: 0 },
  { value: "slow", label: "Slow", title: "A full turn in a minute", degrees: 6 },
  { value: "medium", label: "Medium", title: "A full turn in half a minute", degrees: 12 },
  { value: "fast", label: "Fast", title: "A full turn in fifteen seconds", degrees: 24 },
] as const satisfies readonly (ViewChoice<string> & { degrees: number })[];

export type RenderMode = (typeof RENDER_MODES)[number]["value"];
export type Shading = (typeof SHADINGS)[number]["value"];
export type Projection = (typeof PROJECTIONS)[number]["value"];
export type Background = (typeof BACKGROUNDS)[number]["value"];
export type OrbitSpeed = (typeof ORBITS)[number]["value"];

export interface ViewSettings {
  readonly mode: RenderMode;
  readonly shading: Shading;
  readonly projection: Projection;
  readonly background: Background;
  readonly orbit: OrbitSpeed;
}

const CHOICES = {
  mode: RENDER_MODES,
  shading: SHADINGS,
  projection: PROJECTIONS,
  background: BACKGROUNDS,
  orbit: ORBITS,
} as const;

export function defaultView(): ViewSettings {
  return {
    mode: "textured",
    shading: "app",
    projection: "perspective",
    background: "sky",
    orbit: "off",
  };
}

/** Saved settings over the defaults; anything unknown keeps its default. */
export function readView(saved: unknown): ViewSettings {
  const view: Record<string, string> = { ...defaultView() };
  if (saved && typeof saved === "object") {
    for (const [key, choices] of Object.entries(CHOICES)) {
      const value = (saved as Record<string, unknown>)[key];
      if (choices.some((c) => c.value === value)) view[key] = value as string;
    }
  }
  return view as unknown as ViewSettings;
}

/** Degrees per second for an orbit choice. */
export function orbitDegrees(orbit: OrbitSpeed): number {
  return ORBITS.find((o) => o.value === orbit)?.degrees ?? 0;
}
