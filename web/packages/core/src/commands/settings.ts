import { SettingsArg } from "../settings.ts";
import { defineCommand } from "./command.ts";

/**
 * Changes project settings: its name, which of its directions is the real north, where the
 * major grid lines fall, and the note shown when it is opened. Cells never move when north
 * changes; it turns what crosses in or out.
 */
export const settings = defineCommand({
  kind: "settings",
  args: SettingsArg.partial(),
  apply(ctx, patch) {
    const current = ctx.settings;
    const next = {
      name: patch.name ?? current.name,
      north: patch.north ?? current.north,
      grid: patch.grid ?? current.grid,
      note: patch.note !== undefined ? patch.note.trim() : current.note,
    };
    const same =
      next.name === current.name &&
      next.north === current.north &&
      next.grid[0] === current.grid[0] &&
      next.grid[1] === current.grid[1] &&
      next.note === current.note;
    if (!same) {
      const grid = Object.freeze([next.grid[0], next.grid[1]] as const);
      ctx.setSettings(Object.freeze({ ...next, grid }));
    }
  },
});
