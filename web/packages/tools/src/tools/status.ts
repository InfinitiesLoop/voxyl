import { regionStats } from "@voxyl/core";
import { z } from "zod";
import { boundsOf } from "../result.ts";
import { defineTool } from "../tool.ts";
import { historyLabels } from "./history.ts";

/** How many semantics status lists before it only counts the rest. */
const SEMANTIC_CAP = 200;

export const CONVENTIONS =
  "Positions are [x, y, z] integer cells. +Y is up, north is -Z, south +Z, west -X, east +X. " +
  "Cells hold semantic names (intent), never materials; palettes map names to blocks. " +
  "Regions take {box:[x0,y0,z0,x1,y1,z1]}, {semantic}, {palette}, {selection:true}, {all}, {any}, {not}. " +
  'Every edit is one undo step named "Claude: <tool>"; pass dry_run to preview and op_id to make a call safe to repeat.';

export const status = defineTool({
  name: "status",
  title: "Project status",
  description:
    "The first call: project name, size, palettes and semantic names, the user's selection, " +
    "the next undo and redo, whether an editor tab is attached, and the coordinate conventions.",
  input: z.strictObject({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  handler(host) {
    const project = host.project;
    const out: Record<string, unknown> = {
      editor_attached: host.editorAttached ?? false,
      conventions: CONVENTIONS,
    };
    if (!project) return { ...out, project: null };
    const stats = regionStats(project);
    const registry = project.semantics;
    let listed = 0;
    const palettes = registry.palettes().map((p) => {
      const semantics = registry.semanticsIn(p.id).flatMap((id) => {
        if (listed >= SEMANTIC_CAP) return [];
        listed++;
        const shape = registry.resolve(id).form.shape;
        return [{ name: registry.nameOf(id), ...(shape !== undefined && { shape }) }];
      });
      return {
        name: p.name,
        ...(p.extends !== undefined && { extends: registry.palette(p.extends).name }),
        semantics,
      };
    });
    const selection = project.selection;
    return {
      ...out,
      project: {
        name: project.settings.name,
        north: project.settings.north,
        cells: stats.cells,
        bounds: boundsOf(stats.bounds),
      },
      palettes,
      semantics_truncated: registry.size > SEMANTIC_CAP,
      selection: selection ? { cells: selection.size, bounds: boundsOf(selection.bounds()) } : null,
      history: historyLabels(project),
    };
  },
});
