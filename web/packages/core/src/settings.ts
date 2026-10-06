// Project settings (web-core.md, section 9): its name, which of its directions is the real
// north, and where the major grid lines fall. Changed by the `settings` command like any other
// project change, and saved in the manifest.

import { z } from "zod";
import { type Direction, DirectionArg } from "./transform.ts";

/** Major grid lines run every this many cells. */
export const MAJOR_GRID = 16;

export interface ProjectSettings {
  readonly name: string;
  /**
   * Which of the project's own directions points to the real north: "north" (-Z, the default),
   * "east" (+X), "south" or "west". Cells never move when it changes; it orients the compass
   * and turns cells crossing into or out of the project (see turnsBetween).
   */
  readonly north: Direction;
  /** Major grid lines run along the west and north edges of cells at x, z = offset + 16k. */
  readonly grid: readonly [x: number, z: number];
}

export const DEFAULT_SETTINGS: ProjectSettings = Object.freeze({
  name: "Untitled",
  north: "north",
  grid: Object.freeze([0, 0] as const),
});

const Offset = z
  .number()
  .int()
  .min(0)
  .max(MAJOR_GRID - 1);

export const SettingsArg = z.strictObject({
  name: z.string().trim().min(1).max(120),
  north: DirectionArg,
  grid: z.tuple([Offset, Offset]),
});

/** Settings as loaded: anything missing or invalid falls back to the default. */
export function settingsFrom(json: unknown): ProjectSettings {
  const partial = SettingsArg.partial().safeParse(json ?? {});
  const s = partial.success ? partial.data : {};
  return Object.freeze({
    name: s.name ?? DEFAULT_SETTINGS.name,
    north: s.north ?? DEFAULT_SETTINGS.north,
    grid: Object.freeze([...(s.grid ?? DEFAULT_SETTINGS.grid)] as [number, number]),
  });
}
