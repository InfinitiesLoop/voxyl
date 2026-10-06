import { z } from "zod";
import { CommandError, defineCommand, IdArg, NameArg } from "./command.ts";

/** Adds a palette, optionally extending another (a group of the build, or a theme layer). */
export const paletteAdd = defineCommand({
  kind: "palette_add",
  args: z.strictObject({
    name: NameArg,
    description: z.string().optional(),
    extends: IdArg.optional(),
  }),
  apply(ctx, { name, description, extends: parent }) {
    try {
      ctx.semantics.addPalette(name, {
        ...(description !== undefined && { description }),
        ...(parent !== undefined && { extends: parent }),
      });
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
