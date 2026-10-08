import { z } from "zod";
import { CommandError, defineCommand, IdArg } from "./command.ts";

/**
 * Removes a semantic from its palette. Refused while any cell uses it (re-semantic those cells
 * first) or another palette's semantic derives from it, and in a linked palette. Undoes like
 * any command.
 */
export const semanticRemove = defineCommand({
  kind: "semantic_remove",
  args: z.strictObject({ semantic: IdArg }),
  apply(ctx, { semantic }) {
    if (!ctx.semantics.has(semantic)) throw new CommandError(`Unknown semantic id ${semantic}`);
    const used = ctx.cells({ semantic }).size;
    if (used > 0) {
      const name = ctx.semantics.nameOf(semantic);
      throw new CommandError(
        `${used} ${used === 1 ? "cell uses" : "cells use"} ${name}: switch them to another semantic first`,
      );
    }
    try {
      ctx.semantics.remove(semantic);
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
