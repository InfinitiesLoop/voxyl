import type { Region } from "@voxyl/core";
import { z } from "zod";
import { CellFields, planCell } from "../cell.ts";
import { resolveSemantic, SemRef } from "../names.ts";
import { resolveRegion, ToolRegion } from "../region.ts";
import { editResult, MutatingFields } from "../result.ts";
import { EditExtras, expandRegionSpecs, expansionNotes, planImages } from "../symmetry.ts";
import { type CommandSpec, defineTool, ToolError } from "../tool.ts";

const STYLES = ["solid", "hollow", "walls", "frame", "floor"] as const;

export const fill = defineTool({
  name: "fill",
  title: "Fill a region",
  description:
    "Fill a region with one semantic (a shaped one fills every cell with that part; it " +
    "replaces what was there). `style`: solid (default) every cell; hollow only the outer " +
    "shell, and the inside is cleared unless keep_inside; walls the vertical outer faces " +
    "(no floor or ceiling); frame the 12 edges; floor the bottom layer. Styles other than " +
    "solid work from the region's bounding box. Counts the cells changed.",
  input: z.strictObject({
    where: ToolRegion,
    semantic: SemRef,
    style: z.enum(STYLES).optional().describe("Default solid."),
    keep_inside: z
      .boolean()
      .optional()
      .describe("hollow only: leave what is inside the shell instead of clearing it."),
    ...CellFields,
    ...EditExtras,
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(_host, args, call) {
    const project = call.project;
    const style = args.style ?? "solid";
    const target = resolveSemantic(project, args.semantic);
    const ignored = new Set<string>();
    const plan = planCell(target, args, ignored);
    if (plan.kind === "reject") {
      throw new ToolError("bad_argument", plan.detail, { reason: plan.reason });
    }
    const state =
      plan.kind === "block"
        ? plan.state
        : { parts: [plan.part], ...(plan.tags !== undefined && { tags: plan.tags }) };
    const where = resolveRegion(project, args.where);
    const problems = [...ignored];
    const specs: CommandSpec[] = [];
    const fillAt = (region: Region) => specs.push({ kind: "fill", args: { where: region, state } });

    if (style === "solid") fillAt(where);
    else if (style === "hollow") {
      const inside: Region = { shrink: 1, of: where };
      if (args.keep_inside !== true) specs.push({ kind: "clear", args: { where: inside } });
      fillAt({ all: [where, { not: inside }] });
    } else {
      const bounds = project.cells(where).bounds();
      if (!bounds) {
        problems.push("The region holds no cells; nothing was filled.");
      } else {
        const { x0, y0, z0, x1, y1, z1 } = bounds;
        const box = (...b: [number, number, number, number, number, number]): Region => ({
          box: b,
        });
        if (style === "walls") {
          // Everything but the inner column; a region too thin to have one is all wall.
          const thick = x1 - x0 >= 2 && z1 - z0 >= 2;
          fillAt(
            thick ? { all: [where, { not: box(x0 + 1, y0, z0 + 1, x1 - 1, y1, z1 - 1) }] } : where,
          );
        } else if (style === "floor") {
          fillAt({ all: [where, box(x0, y0, z0, x1, y0, z1)] });
        } else {
          const edges: Region[] = [];
          for (const y of [y0, y1]) {
            for (const z of [z0, z1]) edges.push(box(x0, y, z, x1, y, z));
          }
          for (const x of [x0, x1]) {
            for (const z of [z0, z1]) edges.push(box(x, y0, z, x, y1, z));
            for (const y of [y0, y1]) edges.push(box(x, y, z0, x, y, z1));
          }
          fillAt({ all: [where, { any: edges }] });
        }
      }
    }
    const images = planImages(args);
    const expanded = expandRegionSpecs(project, images, specs);
    if (expanded.skipped > 0) {
      problems.push(`${expanded.skipped} copy(ies) left out: a part has no mirror image.`);
    }
    const summary = expanded.specs.length > 0 ? await call.run(expanded.specs) : null;
    return editResult(summary, { style, problems, ...expansionNotes(images, expanded.skipped) });
  },
});
