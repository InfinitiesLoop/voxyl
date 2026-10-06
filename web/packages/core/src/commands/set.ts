import { z } from "zod";
import { EMPTY_ID } from "../cell-state.ts";
import { CellStateArg, CommandError, defineCommand } from "./command.ts";

/**
 * Sets explicit cells, for freehand edits and anything that isn't a shape. `states` lists the
 * distinct states once (null clears), and `cells` is flat [x, y, z, stateIndex] quadruples,
 * so a stroke of a thousand cells of one state stays small.
 */
export const set = defineCommand({
  kind: "set",
  args: z.strictObject({
    states: z.array(CellStateArg.nullable()).min(1),
    cells: z.array(z.number().int()),
  }),
  apply(ctx, { states, cells }) {
    if (cells.length % 4 !== 0)
      throw new CommandError("cells must be [x, y, z, stateIndex] quadruples");
    const ids = states.map((s) => (s === null ? EMPTY_ID : ctx.intern(s)));
    for (let i = 0; i < cells.length; i += 4) {
      const id = ids[cells[i + 3] ?? -1];
      if (id === undefined) throw new CommandError(`cells[${i + 3}] is not a state index`);
      ctx.set(cells[i] ?? 0, cells[i + 1] ?? 0, cells[i + 2] ?? 0, id);
    }
  },
});
