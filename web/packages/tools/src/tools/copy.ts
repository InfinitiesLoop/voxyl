import { cutPiece, defaultAnchor } from "@voxyl/core";
import { z } from "zod";
import { occupied } from "../pieces.ts";
import { PosSchema, resolveRegion, ToolRegion } from "../region.ts";
import { boundsOf, editResult, MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

export const copy = defineTool({
  name: "copy",
  title: "Copy to the clipboard",
  description:
    "Copy the cells of a region to the clipboard (replacing what it held), then `paste` them " +
    "anywhere, turned or mirrored. The region's bounding box is what is copied, its empty cells " +
    "as air. `anchor` ([x,y,z], default: middle of the footprint on the floor) is the cell paste " +
    "puts at its target. With cut:true the region is cleared too (one undo step). The clipboard " +
    "also lives across projects.",
  input: z.strictObject({
    where: ToolRegion,
    anchor: PosSchema.optional().describe(
      "World cell the paste anchors on. Default: floor centre.",
    ),
    cut: z.boolean().optional().describe("Clear the region after copying."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(host, args, call) {
    if (!host.clipboard) {
      throw new ToolError("unavailable", "This host has no clipboard.");
    }
    const project = call.project;
    const where = resolveRegion(project, args.where);
    const cells = project.cells(where);
    const b = cells.bounds();
    if (!b) return editResult(null, { copied: 0, problems: ["The region holds no cells."] });
    const [ax, ay, az] = defaultAnchor([b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1]);
    const anchor = args.anchor ?? [b.x0 + ax, b.y0 + ay, b.z0 + az];
    const piece = cutPiece(
      {
        world: project.world,
        semantics: project.semantics,
        id: project.id,
        north: project.settings.north,
      },
      cells,
      anchor,
    );
    if (!piece) return editResult(null, { copied: 0, problems: ["The region holds no cells."] });
    if (occupied(piece) === 0) {
      return editResult(null, { copied: 0, problems: ["The region holds no cells."] });
    }
    if (!call.dryRun) await host.clipboard.set(piece, "agent");
    const summary = args.cut === true ? await call.run([{ kind: "clear", args: { where } }]) : null;
    return editResult(summary, {
      ...(call.dryRun && { dry_run: true }),
      copied: occupied(piece),
      size: piece.size,
      anchor,
      source_bounds: boundsOf(b),
      copied_semantics: piece.semantics.map((s) => s.name),
    });
  },
});
