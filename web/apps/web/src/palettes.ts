import type { CellStateTable } from "@voxyl/core";
import { type LightMaterials, packEmission } from "@voxyl/light";

// Palettes map semantics to looks: a colour, and for lighting whether the material lets light
// through and whether it glows. They live apart from the world: switching one changes a lookup
// texture (and, with lighting on, the derived light), never a cell. Unmapped semantics render
// as undecided: neutral grey, opaque, unlit.

export interface Material {
  readonly color: string;
  /** Lets light through, like glass. */
  readonly transparent?: boolean;
  /** Emits light of this colour and level (0..15), like a lamp. */
  readonly emits?: { readonly color: string; readonly level: number };
}

export interface Palette {
  readonly name: string;
  readonly materials: Readonly<Record<string, Material>>;
}

export const UNDECIDED_COLOR = "#8a8f98";

const CONCRETE: Palette = {
  name: "Concrete",
  materials: {
    Ground: { color: "#2c3036" },
    Road: { color: "#1b1d21" },
    Mass: { color: "#3b4048" },
    Glass: { color: "#5f8796", transparent: true },
    Trim: { color: "#c8cdd5" },
    Roof: { color: "#545a63" },
    Glow: { color: "#22d3ee", emits: { color: "#22d3ee", level: 15 } },
  },
};

export const PALETTES: readonly Palette[] = [
  CONCRETE,
  {
    name: "Brick",
    materials: {
      Ground: { color: "#6b5d4a" },
      Road: { color: "#3a3733" },
      Mass: { color: "#9a553a" },
      Glass: { color: "#cdb98a", transparent: true },
      Trim: { color: "#e6d9bc" },
      Roof: { color: "#5b3b2c" },
      Glow: { color: "#ffb347", emits: { color: "#ffb347", level: 15 } },
    },
  },
  { name: "Undecided", materials: {} },
];

/** The palette at `index`, or the first one when out of range. */
export function paletteAt(index: number): Palette {
  return PALETTES[index] ?? CONCRETE;
}

/** Per cell-state opacity and emission for the light engine, from the palette. */
export function lightMaterials(palette: Palette, states: CellStateTable): LightMaterials {
  const size = states.size + 1;
  const opaque = new Uint8Array(size);
  const emission = new Uint16Array(size);
  for (let id = 1; id < size; id++) {
    const state = states.get(id);
    const material = palette.materials[state?.semantic ?? ""];
    // Shaped parts let light through, as Minecraft's slabs and stairs light from their neighbours.
    opaque[id] = material?.transparent || (state?.parts.length ?? 0) > 0 ? 0 : 1;
    if (material?.emits) emission[id] = packEmission(material.emits.color, material.emits.level);
  }
  return { opaque, emission };
}
