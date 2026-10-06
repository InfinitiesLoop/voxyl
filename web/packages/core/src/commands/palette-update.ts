import { z } from "zod";
import { CommandError, defineCommand, IdArg, NameArg } from "./command.ts";

/** Renames, describes or re-parents a palette. No cell changes. */
export const paletteUpdate = defineCommand({
  kind: "palette_update",
  args: z.strictObject({
    palette: IdArg,
    name: NameArg.optional(),
    description: z.string().nullable().optional(),
    extends: IdArg.nullable().optional(),
  }),
  apply(ctx, { palette, name, description, extends: parent }) {
    try {
      ctx.semantics.updatePalette(palette, {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(parent !== undefined && { extends: parent }),
      });
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
