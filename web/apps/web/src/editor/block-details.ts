// What the crosshair is on, as the 3D view says it. A lens: the semantic id comes from the
// aim, and the name, block, library and glow come from the palettes, so a re-skin updates the readout
// without touching a cell (CLAUDE.md principles 2 and 3).

import { blockLabel, DEFAULT_LIBRARY_ID, DEFAULT_LIBRARY_NAME, parseBlockRef } from "@voxyl/blocks";
import type { PaletteInfo } from "../world/editing.ts";

/** A block library as the tooltip names it: its id and the name it shows. */
export interface LibraryName {
  readonly id: string;
  readonly name: string;
}

export interface BlockDetail {
  readonly name: string;
  /** The palette the semantic lives in: the one its look resolves through. */
  readonly palette: string;
  /** The assigned block's label, or null while the semantic is undecided. */
  readonly block: string | null;
  /** The block library that look names, or null while undecided. */
  readonly library: string | null;
  /** The block ref the preview bakes, absent while undecided. */
  readonly blockRef?: string;
  /** Hint colour: the swatch until a bake arrives, and the tint of a part's picture. */
  readonly color: string;
  readonly glow: boolean;
}

/** The readout for a semantic id, or null when the palettes don't offer it. */
export function blockDetail(
  palettes: readonly PaletteInfo[],
  semantic: number,
  libraries: readonly LibraryName[] = [],
): BlockDetail | null {
  const palette = palettes.find((p) => p.semantics.some((s) => s.ref === semantic));
  const info = palette?.semantics.find((s) => s.ref === semantic);
  if (!palette || !info) return null;
  return {
    name: info.name,
    palette: palette.name,
    block: info.block ? blockLabel(info.block) : null,
    library: info.block ? libraryName(info.block, libraries) : null,
    ...(info.block !== undefined && { blockRef: info.block }),
    color: info.color,
    glow: info.glow,
  };
}

/** The library a block ref belongs to, by the name it shows, else its id. */
function libraryName(ref: string, libraries: readonly LibraryName[]): string | null {
  const parsed = parseBlockRef(ref);
  if (!parsed) return null;
  const named = libraries.find((library) => library.id === parsed.library)?.name;
  if (named) return named;
  if (parsed.library === DEFAULT_LIBRARY_ID) return DEFAULT_LIBRARY_NAME;
  return parsed.library;
}
