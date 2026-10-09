import { boxVolume, type Project, type Region, regionStats, regionText } from "@voxyl/core";
import { z } from "zod";
import { Names } from "../names.ts";
import { resolveRegion, ToolRegion } from "../region.ts";
import { boundsOf } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

/** Rows of counts a summary or materials view lists before it only says there are more. */
const ROW_CAP = 50;
/** The most cells the layers view prints: about 10k tokens. Narrow `where` for more. */
const LAYER_CELLS = 32_768;
const CELLS_DEFAULT = 100;
const CELLS_MAX = 1000;

export const inspect = defineTool({
  name: "inspect",
  title: "Inspect cells",
  description:
    "Read the build. view summary: bounds, cell count, blocks and parts by semantic. " +
    "materials: the same grouped by the actual block each semantic maps to (a shopping list). " +
    "layers: text layers with a legend (axis y = plan view, layers go up; z = elevation seen " +
    "from the south; x = seen from the east), capped to about 32k cells. cells: up to `limit` " +
    "cells with full state (facing, up, parts), paged by `offset`. `where` defaults to the " +
    "whole build.",
  input: z.strictObject({
    view: z.enum(["summary", "materials", "layers", "cells"]).default("summary"),
    where: ToolRegion.optional(),
    axis: z.enum(["x", "y", "z"]).optional().describe("layers only; default y."),
    limit: z.number().int().min(1).max(CELLS_MAX).optional().describe("cells only; default 100."),
    offset: z.number().int().min(0).optional().describe("cells only; skip this many first."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler(_host, args, call) {
    const project = call.project;
    const region = args.where ? resolveRegion(project, args.where) : undefined;
    const names = new Names(project);
    switch (args.view) {
      case "summary": {
        const s = regionStats(project, region);
        return {
          view: "summary",
          cells: s.cells,
          bounds: boundsOf(s.bounds),
          blocks: s.blocks
            .slice(0, ROW_CAP)
            .map((b) => ({ ...names.ref(b.semantic), count: b.count })),
          parts: s.parts
            .slice(0, ROW_CAP)
            .map((p) => ({ ...names.ref(p.semantic), shape: p.shape, count: p.count })),
          truncated: s.blocks.length > ROW_CAP || s.parts.length > ROW_CAP,
        };
      }
      case "materials": {
        const s = regionStats(project, region);
        return {
          view: "materials",
          cells: s.cells,
          materials: s.materials.slice(0, ROW_CAP).map((m) => ({
            block: m.block,
            shape: m.shape,
            count: m.count,
            semantics: m.semantics.map((id) => names.name(id)),
          })),
          truncated: s.materials.length > ROW_CAP,
        };
      }
      case "layers": {
        const where = region ?? wholeBuild(project);
        if (where === null)
          return { view: "layers", axis: args.axis ?? "y", layers: [], legend: {} };
        const bounds = project.cells(where).bounds();
        if (bounds && boxVolume(bounds) > LAYER_CELLS) {
          throw new ToolError(
            "too_large",
            `The region spans ${boxVolume(bounds)} cells; layers prints at most ${LAYER_CELLS}. Narrow \`where\`, or use summary.`,
            { bounds: boundsOf(bounds), cells_in_bounds: boxVolume(bounds), limit: LAYER_CELLS },
          );
        }
        const text = regionText(project, where, args.axis ?? "y");
        return { view: "layers", ...text };
      }
      case "cells": {
        const limit = args.limit ?? CELLS_DEFAULT;
        const offset = args.offset ?? 0;
        const cells: Record<string, unknown>[] = [];
        let total = 0;
        project.forEachIn(region, (x, y, z, id) => {
          const index = total++;
          if (index < offset || cells.length >= limit) return;
          const state = project.world.states.get(id);
          if (state) cells.push({ at: [x, y, z], ...names.describe(state) });
        });
        return {
          view: "cells",
          total,
          offset,
          returned: cells.length,
          cells,
          ...(offset + cells.length < total && { next_offset: offset + cells.length }),
        };
      }
    }
  },
});

/** A box around everything built, or null for an empty project. */
function wholeBuild(project: Project): Region | null {
  const b = regionStats(project).bounds;
  return b ? { box: [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1] } : null;
}
