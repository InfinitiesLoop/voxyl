import { z } from "zod";
import { resolveRegion, ToolRegion } from "../region.ts";
import { boundsOf, MutatingFields } from "../result.ts";
import { defineTool } from "../tool.ts";

export const select = defineTool({
  name: "select",
  title: "Set the selection",
  description:
    "Set the user's selection to the cells of a region, or clear it with where: null. The " +
    "selection is what the user sees highlighted in the editor; other tools reach it with " +
    "{selection: true}. To refine the current selection, write the expression, e.g. " +
    '{all:[{selection:true},{semantic:"Trim"}]}. You rarely need it: pass the region ' +
    "straight to the tool that acts on it.",
  input: z.strictObject({
    where: ToolRegion.nullable().describe("The cells to select, or null to clear."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(_host, args, call) {
    const where = args.where === null ? null : resolveRegion(call.project, args.where);
    const summary = await call.run([{ kind: "select", args: { where } }]);
    const selection = summary.after.selection;
    return {
      ...(summary.dryRun && { dry_run: true }),
      ...(summary.duplicate && { duplicate: true }),
      selected: selection?.size ?? 0,
      bounds: boundsOf(selection?.bounds() ?? null),
      problems:
        where !== null && !selection
          ? ["The region holds no cells; the selection is now empty."]
          : [],
    };
  },
});
