import { z } from "zod";
import {
  CommandError,
  defineCommand,
  defined,
  FormArg,
  LookArg,
  NameArg,
  SemanticArg,
} from "./command.ts";

/**
 * Changes what a semantic is called, means, is (form) or looks like. No cell changes: cells
 * hold the id. On a derived semantic, null goes back to inheriting from the base; the
 * { palette, base } form derives the semantic first, to override a look before placing it.
 */
export const semanticUpdate = defineCommand({
  kind: "semantic_update",
  args: z.strictObject({
    semantic: SemanticArg,
    name: NameArg.nullable().optional(),
    description: z.string().nullable().optional(),
    form: FormArg.nullable().optional(),
    look: LookArg.nullable().optional(),
  }),
  apply(ctx, { semantic, name, description, form, look }) {
    const id = ctx.semantic(semantic);
    try {
      ctx.semantics.update(id, {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(form !== undefined && { form: form && defined(form) }),
        ...(look !== undefined && { look: look && defined(look) }),
      });
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
