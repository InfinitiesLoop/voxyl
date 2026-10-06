import { z } from "zod";
import { CommandError, defineCommand, defined, FormArg, LookArg, NameArg } from "./command.ts";

/**
 * Brings in a shared (user-level) palette as a linked copy, or re-syncs the copy. The command
 * carries the shared palette's content, so replaying it gives the same result anywhere. Project
 * palettes extend the copy to follow its looks; the copy itself is read-only in the project.
 */
export const paletteSync = defineCommand({
  kind: "palette_sync",
  args: z.strictObject({
    key: z.string().min(1),
    version: z.number().int().min(0),
    name: NameArg,
    description: z.string().optional(),
    semantics: z.array(
      z.strictObject({
        key: z.string().min(1),
        name: NameArg,
        description: z.string().optional(),
        form: FormArg.optional(),
        look: LookArg.optional(),
      }),
    ),
  }),
  apply(ctx, shared) {
    try {
      ctx.semantics.sync({
        key: shared.key,
        version: shared.version,
        name: shared.name,
        ...(shared.description !== undefined && { description: shared.description }),
        semantics: shared.semantics.map((s) => ({
          key: s.key,
          name: s.name,
          ...(s.description !== undefined && { description: s.description }),
          ...(s.form !== undefined && { form: defined(s.form) }),
          ...(s.look !== undefined && { look: defined(s.look) }),
        })),
      });
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
