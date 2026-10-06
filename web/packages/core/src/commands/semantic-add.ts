import { z } from "zod";
import {
  CommandError,
  defineCommand,
  defined,
  FormArg,
  IdArg,
  LookArg,
  NameArg,
} from "./command.ts";

/** Adds a semantic to a palette (the root palette by default). */
export const semanticAdd = defineCommand({
  kind: "semantic_add",
  args: z.strictObject({
    name: NameArg,
    palette: IdArg.optional(),
    description: z.string().optional(),
    form: FormArg.optional(),
    look: LookArg.optional(),
  }),
  apply(ctx, { name, palette, description, form, look }) {
    try {
      ctx.semantics.add(name, {
        ...(palette !== undefined && { palette }),
        ...(description !== undefined && { description }),
        ...(form !== undefined && { form: defined(form) }),
        ...(look !== undefined && { look: defined(look) }),
      });
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
