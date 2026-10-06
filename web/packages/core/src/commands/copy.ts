import { z } from "zod";
import { PosArg, Region } from "../region.ts";
import { PlacementArgs } from "../transform.ts";
import { defineCommand } from "./command.ts";
import { relocate } from "./relocate.ts";

/**
 * Copies a region's cells so the corner of the result lands at `to`, optionally turned
 * (quarter turns clockwise from above) and mirrored. Blocks and parts turn with their cells.
 * With `air`, the region's empty cells clear what they land on. Notes: "cells", "rejected"
 * (parts with no mirror image, left out).
 */
export const copy = defineCommand({
  kind: "copy",
  args: z.strictObject({
    where: Region,
    to: PosArg,
    ...PlacementArgs,
    air: z.boolean().optional(),
  }),
  apply(ctx, args) {
    relocate(ctx, args, false);
  },
});
