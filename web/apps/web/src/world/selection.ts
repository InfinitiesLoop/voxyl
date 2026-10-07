// What a selection holds, for the panel: counts by semantic and by the block each look maps
// to. The outline travels with it so the main thread only draws.

import { blockLabel } from "@voxyl/blocks";
import { type Project, type RegionStats, regionStats } from "@voxyl/core";
import { type BlockMaterials, lookColor } from "@voxyl/session";
import type { Outline } from "../editor/outline.ts";
import type { SelectionRow, SelectionView } from "./protocol.ts";

/** The panel's picture of the open project's selection. */
export function selectionView(
  project: Project,
  outline: Outline,
  blocks?: BlockMaterials,
): SelectionView {
  const stats = regionStats(project, { selection: true });
  const bounds = outline.bounds;
  return {
    cells: project.selection?.size ?? 0,
    occupied: stats.cells,
    box: outline.box,
    exact: outline.exact,
    bounds: bounds ? [bounds.x0, bounds.y0, bounds.z0, bounds.x1, bounds.y1, bounds.z1] : null,
    semantics: semanticRows(project, stats, blocks),
    materials: materialRows(project, stats, blocks),
    lines: outline.lines,
  };
}

function colorOf(project: Project, semantic: number, blocks?: BlockMaterials): string {
  const look = project.semantics.has(semantic) ? project.semantics.resolve(semantic).look : {};
  return lookColor(look, blocks);
}

function semanticRows(
  project: Project,
  stats: RegionStats,
  blocks?: BlockMaterials,
): SelectionRow[] {
  const rows: SelectionRow[] = [];
  for (const block of stats.blocks) {
    rows.push({
      semantic: block.semantic,
      name: block.name,
      color: colorOf(project, block.semantic, blocks),
      count: block.count,
    });
  }
  for (const part of stats.parts) {
    rows.push({
      semantic: part.semantic,
      name: part.name,
      color: colorOf(project, part.semantic, blocks),
      count: part.count,
      detail: part.shape,
    });
  }
  return rows;
}

function materialRows(
  project: Project,
  stats: RegionStats,
  blocks?: BlockMaterials,
): SelectionRow[] {
  return stats.materials.map((material) => {
    const names = material.semantics.map((id) => project.semantics.nameOf(id));
    const name = material.block ? blockLabel(material.block) : names.join(", ");
    const detail = [material.shape, material.block && names.length > 1 ? names.join(", ") : ""]
      .filter((part) => part !== "" && part !== null)
      .join(" · ");
    const semantic = material.semantics[0] ?? 0;
    return {
      semantic,
      name,
      color: colorOf(project, semantic, blocks),
      count: material.count,
      ...(detail !== "" && { detail }),
    };
  });
}
