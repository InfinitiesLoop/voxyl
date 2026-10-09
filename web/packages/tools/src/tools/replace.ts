import { z } from "zod";
import { resolveSemantic, SemRef } from "../names.ts";
import { resolveRegion, ToolRegion } from "../region.ts";
import { editResult, MutatingFields } from "../result.ts";
import { defineTool } from "../tool.ts";

export const replace = defineTool({
  name: "replace",
  title: "Replace a semantic",
  description:
    "Turn every cell holding semantic `from` into semantic `to`, keeping geometry: orientation, " +
    "tags, and a part's shape and slot carry over. `where` limits it (default: the whole " +
    "build). A cell whose geometry doesn't fit `to`'s shape (a whole block where `to` places " +
    "parts, or a different part shape) is skipped and counted, unless `force` relabels it " +
    "anyway. To re-skin a semantic everywhere, edit the palette instead: no cell changes.",
  input: z.strictObject({
    from: SemRef,
    to: SemRef,
    where: ToolRegion.optional(),
    force: z.boolean().optional().describe("Relabel cells whose geometry doesn't fit `to`."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(_host, args, call) {
    const project = call.project;
    const from = resolveSemantic(project, args.from);
    const to = resolveSemantic(project, args.to);
    if (!from.exists) {
      return editResult(null, {
        switched: 0,
        skipped: 0,
        problems: [`${from.name} isn't used by any cell yet; nothing to replace.`],
      });
    }
    const where = args.where
      ? resolveRegion(project, args.where)
      : { semantic: from.arg as number };
    const summary = await call.run([
      {
        kind: "resemantic",
        args: { where, from: from.arg, to: to.arg, ...(args.force && { force: true }) },
      },
    ]);
    const skipped = Number(summary.notes.skipped ?? 0);
    const switched = Number(summary.notes.switched ?? 0);
    return editResult(summary, {
      switched,
      skipped,
      ...(summary.notes.fixed !== undefined && {
        orientation_adjusted: Number(summary.notes.fixed),
      }),
      problems:
        skipped > 0
          ? [
              `${skipped} cell(s) skipped: their geometry doesn't fit ${to.name}'s form. Pass force:true to relabel them anyway.`,
            ]
          : switched === 0
            ? [`No cells hold ${from.name} in that region.`]
            : [],
    });
  },
});
