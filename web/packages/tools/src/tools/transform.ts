import { z } from "zod";
import { resolveRegion, ToolRegion } from "../region.ts";
import { editResult, MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

const Pos = z.tuple([z.number().int(), z.number().int(), z.number().int()]);

export const transform = defineTool({
  name: "transform",
  title: "Move, copy, turn or mirror",
  description:
    "Relocate the cells of a region. With `by` ([dx,dy,dz]) or `to` ([x,y,z], where the result's " +
    "lowest corner lands) the cells move there, or are copied with copy:true. Without them the " +
    "region is turned or mirrored in place and keeps its lowest corner. `turn` is quarter turns " +
    "clockwise seen from above (negative: anticlockwise); `mirror` x|y|z flips across that " +
    "axis, after turning. Blocks and parts turn with their cells; parts with no mirror image " +
    "are left out and counted in `rejected`. `air` lets the region's empty cells clear what " +
    "they land on. A prefab or clipboard paste comes with the prefab tools.",
  input: z.strictObject({
    where: ToolRegion,
    by: Pos.optional(),
    to: Pos.optional(),
    copy: z.boolean().optional().describe("Copy instead of move (needs by or to)."),
    turn: z.number().int().min(-3).max(3).optional(),
    mirror: z.enum(["x", "y", "z"]).optional(),
    air: z.boolean().optional(),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async handler(_host, args, call) {
    const project = call.project;
    if (args.by !== undefined && args.to !== undefined) {
      throw new ToolError("bad_argument", "Give `by` or `to`, not both.");
    }
    const where = resolveRegion(project, args.where);
    const moving = args.by !== undefined || args.to !== undefined;
    if (!moving && args.copy === true) {
      throw new ToolError("bad_argument", "A copy needs `by` or `to` to say where it goes.");
    }
    if (!moving && (args.turn ?? 0) % 4 === 0 && args.mirror === undefined) {
      throw new ToolError("bad_argument", "Give by or to, or a turn or mirror.");
    }
    const placement = {
      ...(args.turn !== undefined && { turn: args.turn }),
      ...(args.mirror !== undefined && { mirror: args.mirror }),
    };
    let spec: { kind: string; args: unknown };
    if (!moving) {
      spec = { kind: "transform", args: { where, ...placement } };
    } else {
      let to = args.to;
      if (to === undefined) {
        const bounds = project.cells(where).bounds();
        if (!bounds) return editResult(null, { problems: ["The region holds no cells."] });
        const [dx, dy, dz] = args.by as [number, number, number];
        to = [bounds.x0 + dx, bounds.y0 + dy, bounds.z0 + dz];
      }
      spec = {
        kind: args.copy === true ? "copy" : "move",
        args: { where, to, ...placement, ...(args.air !== undefined && { air: args.air }) },
      };
    }
    const summary = await call.run([spec]);
    const rejected = Number(summary.notes.rejected ?? 0);
    return editResult(summary, {
      cells_written: Number(summary.notes.cells ?? 0),
      ...(rejected > 0 && { rejected_count: rejected }),
      problems:
        rejected > 0
          ? [
              `${rejected} part(s) have no mirror image and were left out (a move keeps them in place).`,
            ]
          : Number(summary.notes.cells ?? 0) === 0
            ? ["The region holds no cells."]
            : [],
    });
  },
});
