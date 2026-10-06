import { z } from "zod";
import { Region } from "../region.ts";
import { CellStateArg, defineCommand } from "./command.ts";

/** Fills a region with one cell state. */
export const fill = defineCommand({
  kind: "fill",
  args: z.strictObject({ where: Region, state: CellStateArg }),
  apply(ctx, { where, state }) {
    ctx.fill(where, ctx.intern(state));
  },
});
