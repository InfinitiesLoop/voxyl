import { z } from "zod";
import { defineCommand } from "./command.ts";

/**
 * Undoes the latest undo step. It names the step's last command, so replaying the history
 * anywhere undoes the same thing; the editor and tools get it from Project.undoTarget().
 */
export const undo = defineCommand({
  kind: "undo",
  undoable: false,
  args: z.strictObject({ target: z.string().min(1) }),
  apply(ctx, { target }) {
    ctx.undo(target);
  },
});
