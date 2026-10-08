import { z } from "zod";
import { CommandError, defineCommand, IdArg } from "./command.ts";

/**
 * Takes a palette out of the project, with its semantics. Refused while any cell uses one of
 * them (re-semantic those cells first), while another palette extends it, and for the root
 * palette. A linked copy goes the same way: the shared palette it came from stays where it is.
 * Undoes like any command.
 */
export const paletteRemove = defineCommand({
  kind: "palette_remove",
  args: z.strictObject({ palette: IdArg }),
  apply(ctx, { palette }) {
    if (!ctx.semantics.hasPalette(palette)) throw new CommandError(`Unknown palette id ${palette}`);
    let used = 0;
    let usedName = "";
    for (const semantic of ctx.semantics.semanticsIn(palette)) {
      const n = ctx.cells({ semantic }).size;
      if (n === 0) continue;
      used += n;
      if (usedName === "") usedName = ctx.semantics.nameOf(semantic);
    }
    if (used > 0) {
      throw new CommandError(
        `${used} ${used === 1 ? "cell uses" : "cells use"} semantics of ${ctx.semantics.palette(palette).name} (${usedName}, for one): switch them to another semantic first`,
      );
    }
    try {
      ctx.semantics.removePalette(palette);
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
