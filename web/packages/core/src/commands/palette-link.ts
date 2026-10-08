import { z } from "zod";
import { CommandError, defineCommand, IdArg } from "./command.ts";

/**
 * Turns a project palette into the linked copy of a shared palette it was just shared as, so
 * the shared one is where it is edited from now on. Its semantics keep their ids (cells and
 * commands keep meaning) and are matched to the shared palette's by key, so a later sync
 * updates them in place. Only a palette that extends nothing and derives nothing can link:
 * a linked copy has no parents (palette_sync drops them).
 */
export const paletteLink = defineCommand({
  kind: "palette_link",
  args: z.strictObject({
    palette: IdArg,
    key: z.string().min(1),
    version: z.number().int().min(0),
    /** Each of the palette's own semantics, by id, and the shared key it has there. */
    keys: z.record(z.string().regex(/^[1-9]\d*$/), z.string().min(1)),
  }),
  apply(ctx, { palette, key, version, keys }) {
    try {
      ctx.semantics.link(
        palette,
        { key, version },
        new Map(Object.entries(keys).map(([id, k]) => [Number(id), k])),
      );
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});

/** Makes a linked copy an ordinary palette again, editable here and no longer following. */
export const paletteUnlink = defineCommand({
  kind: "palette_unlink",
  args: z.strictObject({ palette: IdArg }),
  apply(ctx, { palette }) {
    try {
      ctx.semantics.unlink(palette);
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
