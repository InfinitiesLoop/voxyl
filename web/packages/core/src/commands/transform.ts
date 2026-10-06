import { z } from "zod";
import { Region } from "../region.ts";
import { PlacementArgs } from "../transform.ts";
import { defineCommand } from "./command.ts";
import { relocate } from "./relocate.ts";

/**
 * Turns and/or mirrors a region in place: the result keeps the region's corner (lowest x, y,
 * z). Turning a box that isn't square swaps its x and z extents from that corner.
 */
export const transform = defineCommand({
  kind: "transform",
  args: z
    .strictObject({ where: Region, ...PlacementArgs })
    .refine((a) => (a.turn ?? 0) % 4 !== 0 || a.mirror !== undefined, {
      message: "give a turn or a mirror",
    }),
  apply(ctx, args) {
    relocate(ctx, { ...args, air: false }, true);
  },
});
