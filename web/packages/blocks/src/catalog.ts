// Finding blocks in the libraries a viewer has, for the palette drawer's block picker.
// An icon is one texture, not a render: the top of a cube, or the largest face otherwise.

import type { Libraries } from "./compile.ts";
import { type Block, type Library, MC_SIDES, type McSide, type Texture } from "./library.ts";

const ICON_SIZE = 16;

/** "voxyl:oak_stairs" as "Oak stairs". */
export function blockLabel(ref: string): string {
  const name = ref.slice(ref.indexOf(":") + 1).replaceAll("_", " ");
  if (name === "") return ref;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export interface BlockMatch {
  readonly ref: string;
  readonly name: string;
  readonly color: string;
  /** 16×16 RGBA, tinted, or null when the block has no 16×16 texture. */
  readonly icon: Uint8Array | null;
}

export interface BlockQuery {
  /** Space-separated words; every word must appear in the id or the label. Empty lists all. */
  readonly query: string;
  /** Only this library, when set. */
  readonly library?: string;
  /** Only these libraries, when set and not empty (empty means all of them). */
  readonly libraries?: readonly string[];
  /** How many hits to return. Default 60. */
  readonly limit?: number;
  /** Skip this many hits first, so a viewer can ask for the next page. */
  readonly offset?: number;
}

/** Blocks matching a query, best first, each with an icon. `matched` counts before the limit. */
export function searchBlocks(
  libraries: Libraries,
  query: BlockQuery,
): { matched: number; hits: BlockMatch[] } {
  const terms = query.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "");
  const limit = Math.max(1, query.limit ?? 60);
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const only = query.libraries && query.libraries.length > 0 ? new Set(query.libraries) : null;
  const ranked: { score: number; ref: string; name: string; block: Block; library: Library }[] = [];
  for (const library of libraries.values()) {
    if (query.library !== undefined && library.id !== query.library) continue;
    if (only && !only.has(library.id)) continue;
    for (const id of Object.keys(library.blocks)) {
      const block = library.blocks[id];
      if (!block || block.hidden) continue;
      const ref = `${library.id}:${id}`;
      const name = blockLabel(ref);
      const score = rank(id, name, terms);
      if (score < 0) continue;
      ranked.push({ score, ref, name, block, library });
    }
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const order = (id: string) => (id === "voxyl" ? 0 : 1);
    const byLibrary = order(a.library.id) - order(b.library.id);
    if (byLibrary !== 0) return byLibrary;
    return a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref);
  });
  return {
    matched: ranked.length,
    hits: ranked.slice(offset, offset + limit).map((r) => ({
      ref: r.ref,
      name: r.name,
      color: r.block.color,
      icon: blockIcon(r.library, r.block),
    })),
  };
}

/**
 * A 16×16 RGBA icon: the block's top texture when that face is most of a cell (grass, a log's
 * end), otherwise its largest face (a pane's glass rather than its thin edge).
 */
export function blockIcon(library: Library, block: Block): Uint8Array | null {
  const models = new Set<string>();
  for (const variant of Object.values(block.variants ?? {})) models.add(variant.model);
  for (const part of block.multipart ?? []) models.add(part.apply.model);
  let best: { texture: Texture; tint?: string; score: number } | null = null;
  for (const name of models) {
    const model = library.models[name];
    if (!model) continue;
    for (const element of model.elements) {
      const [x0, y0, z0] = element.from;
      const [x1, y1, z1] = element.to;
      const area = (side: McSide) => {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const dz = Math.abs(z1 - z0);
        if (side === "up" || side === "down") return dx * dz;
        if (side === "east" || side === "west") return dy * dz;
        return dx * dy;
      };
      for (const side of MC_SIDES) {
        const face = element.faces[side];
        const texture = face ? library.textures[face.texture] : undefined;
        if (!face || !texture || texture.size !== ICON_SIZE) continue;
        const size = area(side);
        // A real top (at least a quarter of the cell) shows what a map would: grass, log ends.
        const score = size + (side === "up" && size >= 64 ? 400 : 0);
        if (!best || score > best.score)
          best = { texture, ...(face.tint && { tint: face.tint }), score };
      }
    }
  }
  return best ? tintedCopy(best.texture.rgba, best.tint) : null;
}

/** Higher is better. -1 when a term is missing. */
function rank(id: string, label: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const hay = `${id} ${label}`.toLowerCase();
  if (!terms.every((term) => hay.includes(term))) return -1;
  const words = id.split("_");
  let score = 0;
  for (const term of terms) {
    if (id === term || label.toLowerCase() === term) score += 100;
    else if (id.startsWith(term) || words.some((word) => word.startsWith(term))) score += 10;
    else score += 1;
  }
  return score;
}

function tintedCopy(rgba: Uint8Array, tint: string | undefined): Uint8Array {
  const out = rgba.slice();
  if (!tint) return out;
  const n = Number.parseInt(tint.slice(1), 16);
  if (!Number.isFinite(n)) return out;
  const scale = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++)
      out[i + c] = Math.round(((out[i + c] ?? 0) * (scale[c] ?? 0)) / 255);
  }
  return out;
}
