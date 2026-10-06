// What a region holds, counted (web-core.md, section 9): the read an agent makes before and after
// editing, and the shopping list for building it in-game. Counts are by semantic (intent), with
// a second grouping by the block each semantic's look maps to, for gathering materials.

import type { Box } from "./box.ts";
import { EMPTY_ID } from "./cell-state.ts";
import type { Project } from "./project.ts";
import type { Region } from "./region.ts";
import type { SemanticId } from "./semantics.ts";

export interface RegionStats {
  /** Occupied cells. */
  readonly cells: number;
  /** The box around them, or null when there are none. */
  readonly bounds: Box | null;
  /** Whole blocks by semantic, most first. */
  readonly blocks: readonly { semantic: SemanticId; name: string; count: number }[];
  /** Parts by semantic and shape, most first. */
  readonly parts: readonly { semantic: SemanticId; name: string; shape: string; count: number }[];
  /**
   * The same contents by the block each semantic's look maps to (null: undecided) and shape
   * (null: whole blocks). Semantics sharing a block merge, so there can be fewer rows.
   */
  readonly materials: readonly {
    block: string | null;
    shape: string | null;
    count: number;
    semantics: SemanticId[];
  }[];
}

/** Counts a region's contents (default: the whole build). */
export function regionStats(project: Project, region?: Region): RegionStats {
  const byState = new Map<number, number>();
  let cells = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  project.forEachIn(region, (x, y, z, id) => {
    byState.set(id, (byState.get(id) ?? 0) + 1);
    cells++;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  });
  const bounds: Box | null = cells > 0 ? { x0, y0, z0, x1, y1, z1 } : null;

  const blocks = new Map<SemanticId, number>();
  const parts = new Map<string, { semantic: SemanticId; shape: string; count: number }>();
  for (const [id, n] of byState) {
    const state = id === EMPTY_ID ? null : project.world.states.get(id);
    if (!state) continue;
    if (state.parts.length === 0) {
      blocks.set(state.semantic, (blocks.get(state.semantic) ?? 0) + n);
      continue;
    }
    for (const p of state.parts) {
      const key = `${p.semantic}|${p.shape}`;
      const entry = parts.get(key) ?? { semantic: p.semantic, shape: p.shape, count: 0 };
      entry.count += n;
      parts.set(key, entry);
    }
  }

  const registry = project.semantics;
  const name = (s: SemanticId) => registry.nameOf(s);
  const materials = new Map<
    string,
    { block: string | null; shape: string | null; count: number; semantics: SemanticId[] }
  >();
  const addMaterial = (semantic: SemanticId, shape: string | null, count: number) => {
    const block = registry.has(semantic) ? (registry.resolve(semantic).look.block ?? null) : null;
    // Undecided semantics stay apart: they aren't one material yet.
    const key = block === null ? `?${semantic}|${shape}` : `${block}|${shape}`;
    const entry = materials.get(key) ?? { block, shape, count: 0, semantics: [] };
    entry.count += count;
    if (!entry.semantics.includes(semantic)) entry.semantics.push(semantic);
    materials.set(key, entry);
  };
  for (const [s, count] of blocks) addMaterial(s, null, count);
  for (const p of parts.values()) addMaterial(p.semantic, p.shape, p.count);

  const most = <T extends { count: number }>(rows: T[], tie: (a: T, b: T) => number) =>
    rows.sort((a, b) => b.count - a.count || tie(a, b));
  return {
    cells,
    bounds,
    blocks: most(
      [...blocks].map(([semantic, count]) => ({ semantic, name: name(semantic), count })),
      (a, b) => a.semantic - b.semantic,
    ),
    parts: most(
      [...parts.values()].map((p) => ({ ...p, name: name(p.semantic) })),
      (a, b) => a.semantic - b.semantic || (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0),
    ),
    materials: most(
      [...materials.values()],
      (a, b) => (a.semantics[0] ?? 0) - (b.semantics[0] ?? 0),
    ),
  };
}
