import { z } from "zod";
import { EMPTY_ID } from "../cell-state.ts";
import { Region } from "../region.ts";
import { defineCommand } from "./command.ts";

/** Empties a region. */
export const clear = defineCommand({
  kind: "clear",
  args: z.strictObject({ where: Region }),
  apply(ctx, { where }) {
    ctx.fill(where, EMPTY_ID);
  },
});
