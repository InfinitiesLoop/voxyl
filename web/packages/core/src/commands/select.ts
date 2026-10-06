import { z } from "zod";
import { Region } from "../region.ts";
import { defineCommand } from "./command.ts";

/**
 * Sets the selection to a region's cells, evaluated now (null clears it). The selection is part
 * of the project, so commands that say { selection: true } replay the same anywhere. Selecting
 * relative to the current selection works through the region language, e.g.
 * { all: [{ selection: true }, { palette: 3 }] } to narrow it to a group.
 */
export const select = defineCommand({
  kind: "select",
  args: z.strictObject({ where: Region.nullable() }),
  apply(ctx, { where }) {
    const cells = where === null ? null : ctx.cells(where);
    ctx.setSelection(cells && cells.size > 0 ? cells : null);
    ctx.note("selected", cells?.size ?? 0);
  },
});
