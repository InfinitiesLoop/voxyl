import { SideArg } from "@voxyl/core";
import { z } from "zod";
import { resolveRegion, ToolRegion } from "../region.ts";
import { editResult, MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

const Pos = z.tuple([z.number().int(), z.number().int(), z.number().int()]);

export const transform = defineTool({
  name: "transform",
  title: "Move, copy, turn or mirror",
  description:
    "Relocate a region's cells. With `by` ([dx,dy,dz]) or `to` (where the result's lowest " +
    "corner lands) they move, or are copied with copy:true. Without them the region is turned " +
    "or mirrored in place about its lowest corner: `turn` quarter turns clockwise from above " +
    "(negative: anticlockwise), then `mirror` x|y|z. Parts with no mirror image are left out " +
    "(`rejected_count`). `air`: empty cells clear what they land on. `rotate` {face?, turns?} " +
    "instead turns each cell where it stands about the axis through `face` (default up). For " +
    "a turned copy elsewhere use copy then paste.",
  input: z.strictObject({
    where: ToolRegion,
    by: Pos.optional(),
    to: Pos.optional(),
    copy: z.boolean().optional().describe("Copy instead of move (needs by or to)."),
    turn: z.number().int().min(-3).max(3).optional(),
    mirror: z.enum(["x", "y", "z"]).optional(),
    air: z.boolean().optional(),
    rotate: z
      .strictObject({
        face: SideArg.optional(),
        turns: z.number().int().min(-3).max(3).optional(),
      })
      .optional()
      .describe("Turn each cell where it stands. Cannot combine with by, to, turn or mirror."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async handler(_host, args, call) {
    const project = call.project;
    if (args.by !== undefined && args.to !== undefined) {
      throw new ToolError("bad_argument", "Give `by` or `to`, not both.");
    }
    const where = resolveRegion(project, args.where);
    if (args.rotate !== undefined) {
      if (args.by || args.to || args.copy || args.turn !== undefined || args.mirror || args.air) {
        throw new ToolError(
          "bad_argument",
          "rotate cannot combine with by, to, copy, turn, mirror or air.",
        );
      }
      const turns = args.rotate.turns ?? 1;
      if (turns === 0) throw new ToolError("bad_argument", "rotate.turns can't be 0.");
      const summary = await call.run([
        { kind: "rotate", args: { where, face: args.rotate.face ?? "up", turns } },
      ]);
      const rotated = Number(summary.notes.rotated ?? 0);
      const unchanged = Number(summary.notes.unchanged ?? 0);
      return editResult(summary, {
        rotated,
        unchanged,
        problems:
          rotated === 0
            ? [
                unchanged === 0
                  ? "The region holds no cells."
                  : "No cell changes under that turn (symmetric blocks, or parts with no such slot).",
              ]
            : [],
      });
    }
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
    const rejected = summary.totals.rejected ?? 0;
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
