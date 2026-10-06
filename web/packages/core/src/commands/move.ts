import { z } from "zod";
import { PosArg, Region } from "../region.ts";
import { PlacementArgs } from "../transform.ts";
import { defineCommand } from "./command.ts";
import { relocate } from "./relocate.ts";

/**
 * Moves a region's cells so the corner of the result lands at `to`, optionally turned and
 * mirrored; the cells they leave become empty. Parts with no mirror image stay put (noted as
 * "rejected").
 */
export const move = defineCommand({
  kind: "move",
  args: z.strictObject({
    where: Region,
    to: PosArg,
    ...PlacementArgs,
    air: z.boolean().optional(),
  }),
  apply(ctx, args) {
    relocate(ctx, args, true);
  },
});
