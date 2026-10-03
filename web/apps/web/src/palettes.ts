// Palettes map semantics to colours. They live apart from the world: switching one changes
// only a lookup texture, never a cell or a mesh. Unmapped semantics render as undecided.

export interface Palette {
  readonly name: string;
  readonly colors: Readonly<Record<string, string>>;
}

export const UNDECIDED_COLOR = "#8a8f98";

const CONCRETE: Palette = {
  name: "Concrete",
  colors: {
    Ground: "#2c3036",
    Road: "#1b1d21",
    Mass: "#3b4048",
    Glass: "#5f8796",
    Trim: "#c8cdd5",
    Roof: "#545a63",
    Glow: "#22d3ee",
  },
};

/** The palette at `index`, or the first one when out of range. */
export function paletteAt(index: number): Palette {
  return PALETTES[index] ?? CONCRETE;
}

export const PALETTES: readonly Palette[] = [
  CONCRETE,
  {
    name: "Brick",
    colors: {
      Ground: "#6b5d4a",
      Road: "#3a3733",
      Mass: "#9a553a",
      Glass: "#cdb98a",
      Trim: "#e6d9bc",
      Roof: "#5b3b2c",
      Glow: "#ffb347",
    },
  },
  { name: "Undecided", colors: {} },
];
