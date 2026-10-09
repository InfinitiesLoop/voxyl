import { z } from "zod";
import type { SemanticRegistry, SharedPalette } from "../semantics.ts";
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

/**
 * The arguments of the palette_sync that brings `shared` into a registry as a linked copy (or
 * re-syncs the copy). A project palette with the same name keeps it: the copy is called
 * "Name (shared)".
 */
export function paletteSyncArgs(registry: SemanticRegistry, shared: SharedPalette) {
  const taken = new Set(
    registry
      .palettes()
      .filter((p) => p.linked?.key !== shared.key)
      .map((p) => p.name),
  );
  let name = shared.name;
  for (let n = 1; taken.has(name); n++)
    name = n === 1 ? `${shared.name} (shared)` : `${shared.name} (shared ${n})`;
  return {
    key: shared.key,
    version: shared.version,
    name,
    ...(shared.description !== undefined && { description: shared.description }),
    semantics: shared.semantics.map((s) => ({ ...s })),
  };
}
