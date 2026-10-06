// What each cell state looks like, from the project's registry: semantics resolve their looks
// through palette inheritance, so re-skinning a palette changes this table and never a cell.

import {
  type CellState,
  type CellStateTable,
  type Look,
  ROOT_PALETTE,
  type SemanticId,
  type SemanticRegistry,
} from "@voxyl/core";
import { type LightMaterials, packEmission } from "@voxyl/light";
import { slotName } from "@voxyl/shapes";

/** How an undecided semantic with no hint colour draws. */
export const UNDECIDED_COLOR = "#8a8f98";
/** Light level of a glowing look. */
const GLOW_LEVEL = 15;

export interface StateLooks {
  /**
   * Four bytes per state id (index 0 is empty): red, green, blue, and 1 if it glows. A state of
   * parts is coloured per part, through the plain state of each part's semantic.
   */
  readonly colors: Uint8Array;
  /** Opacity and emission for the light engine. */
  readonly materials: LightMaterials;
}

/** A look's colour: its hint colour for now; blocks from libraries come later. */
export function lookColor(look: Look): string {
  return look.tint ?? UNDECIDED_COLOR;
}

/** Resolves the look of every state in `states`. */
export function stateLooks(states: CellStateTable, registry: SemanticRegistry): StateLooks {
  const size = states.size + 1;
  const colors = new Uint8Array(size * 4);
  const opaque = new Uint8Array(size);
  const emission = new Uint16Array(size);
  const looks = new Map<SemanticId, Look>();
  const lookOf = (semantic: SemanticId): Look => {
    let look = looks.get(semantic);
    if (!look) {
      look = registry.has(semantic) ? registry.resolve(semantic).look : {};
      looks.set(semantic, look);
    }
    return look;
  };
  for (let id = 1; id < size; id++) {
    const state = states.get(id);
    if (!state) continue;
    const parts = state.parts;
    // A cell of parts is drawn per part; it glows if any part does. Shaped parts let light
    // through, as Minecraft lights slabs and stairs from their neighbours.
    const look =
      parts.length > 0
        ? (parts.map((p) => lookOf(p.semantic)).find((l) => l.glow) ??
          lookOf(parts[0]?.semantic ?? 0))
        : lookOf(state.semantic);
    const color = lookColor(look);
    const rgb = Number.parseInt(color.slice(1), 16);
    colors[id * 4] = (rgb >> 16) & 0xff;
    colors[id * 4 + 1] = (rgb >> 8) & 0xff;
    colors[id * 4 + 2] = rgb & 0xff;
    colors[id * 4 + 3] = look.glow ? 1 : 0;
    opaque[id] = parts.length > 0 ? 0 : 1;
    if (look.glow) emission[id] = packEmission(color, GLOW_LEVEL);
  }
  return { colors, materials: { opaque, emission } };
}

/** A cell state in words: "Trim", or its parts, "Trim strip down, Glass post center-y". */
export function describeState(state: CellState, registry: SemanticRegistry): string {
  const name = (semantic: SemanticId) => {
    if (!registry.has(semantic)) return "unknown";
    const resolved = registry.resolve(semantic);
    const palette =
      resolved.palette === ROOT_PALETTE ? "" : ` (${registry.palette(resolved.palette).name})`;
    return `${resolved.name}${palette}`;
  };
  if (state.parts.length === 0) return name(state.semantic);
  return state.parts
    .map((p) => `${name(p.semantic)} ${p.shape} ${slotName(p.shape, p.slot)}`)
    .join(", ");
}
