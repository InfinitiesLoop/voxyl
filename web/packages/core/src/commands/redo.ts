import { z } from "zod";
import { defineCommand } from "./command.ts";

/** Redoes the latest undone step, named by its last command (see Project.redoTarget). */
export const redo = defineCommand({
  kind: "redo",
  undoable: false,
  args: z.strictObject({ target: z.string().min(1) }),
  apply(ctx, { target }) {
    ctx.redo(target);
  },
});
