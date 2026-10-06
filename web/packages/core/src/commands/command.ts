// The command framework (web-core.md, section 1). A command is a small, deterministic
// description of intent, and every change to a project is one. Each command kind lives in its
// own file as a CommandDef: an argument schema and an apply function that writes through the
// context. Undo, ids, change reports, previews and validation are generic (see project.ts), so
// a command never deals with them.

import { z } from "zod";
import type { Box } from "../box.ts";
import type { CellSet } from "../cellset.ts";
import type { Region } from "../region.ts";
import type { SemanticId, SemanticRegistry } from "../semantics.ts";
import type { World } from "../world.ts";

/** A command as it travels: over the relay, into the history, from an agent. */
export interface Command {
  /** Unique per command; a repeat of an id already applied is acknowledged, not reapplied. */
  readonly id: string;
  readonly kind: string;
  readonly args?: unknown;
  /** Who issued it ("Claude", "editor"), for the history view. */
  readonly source?: string;
  /** What it was for ("Pour the hall floor"), for the history view. */
  readonly label?: string;
  /** Consecutive commands sharing a group undo and redo as one step (an agent's task). */
  readonly group?: string;
}

/**
 * What a command may do. Reads go through `world`; cell writes go through the context, which
 * is what makes undo and change reports work without the command's help. Registry changes go
 * through `semantics`, which the project snapshots around every command.
 */
export interface CommandContext {
  readonly world: World;
  readonly semantics: SemanticRegistry;
  /** A semantic reference's id, deriving it into its palette on first use. */
  semantic(ref: SemanticArg): SemanticId;
  /** The cell-state id for a state, resolving its semantic references. */
  intern(state: CellStateArg): number;
  /** Sets one cell to a state id (EMPTY_ID clears it). Returns whether it changed. */
  set(x: number, y: number, z: number, id: number): boolean;
  /** Sets every cell in a box to a state id. Returns how many changed. */
  fillBox(box: Box, id: number): number;
  /** The exact cells of a region (see region.ts). */
  cells(region: Region): CellSet;
  /** Sets every cell of a region to a state id; whole bricks and plain boxes go fast. */
  fill(region: Region, id: number): number;
  /** Visits every occupied cell of a region in a fixed order. */
  forEachIn(region: Region, visit: (x: number, y: number, z: number, id: number) => void): void;
  /** Replaces the project's selection (null clears it). */
  setSelection(cells: CellSet | null): void;
  /** Undoes the latest undo step, which must end with command `target` (see Project.undoTarget). */
  undo(target: string): void;
  /** Redoes the latest undone step, which must end with command `target`. */
  redo(target: string): void;
  /** Adds a figure to the change report ("skipped": 12). */
  note(key: string, value: number | string): void;
}

export interface CommandDef<S extends z.ZodType = z.ZodType> {
  readonly kind: string;
  /** False for commands that aren't undo steps (the selection, undo and redo themselves). */
  readonly undoable?: boolean;
  /** Validates the arguments; later also the MCP tool's input schema. */
  readonly args: S;
  apply(ctx: CommandContext, args: z.output<S>): void;
}

/** Declares a command kind; the schema's output types the apply function's arguments. */
export function defineCommand<S extends z.ZodType>(def: CommandDef<S>): CommandDef<S> {
  return def;
}

/** A thrown error that a command's arguments or target were wrong (not a bug). */
export class CommandError extends Error {
  override readonly name = "CommandError";
}

// --- Shared argument schemas ---

export const IdArg = z.number().int().positive();

/**
 * A semantic: its id, or { palette, base } for the semantic `palette` derives from an
 * ancestor's `base`, created on first use. Names are resolved before a command is built.
 */
export const SemanticArg = z.union([IdArg, z.strictObject({ palette: IdArg, base: IdArg })]);
export type SemanticArg = z.output<typeof SemanticArg>;

export const PartArg = z.strictObject({
  semantic: SemanticArg,
  shape: z.string().min(1),
  slot: z.number().int().min(0),
});

/** A cell state: a whole block (`semantic`) or a list of `parts`, with optional rotation. */
export const CellStateArg = z.strictObject({
  semantic: SemanticArg.optional(),
  rotation: z.number().int().min(0).max(23).optional(),
  tags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  parts: z.array(PartArg).min(1).optional(),
});
export type CellStateArg = z.output<typeof CellStateArg>;

export const NameArg = z.string().trim().min(1).max(80);

export const FormArg = z.strictObject({ shape: z.string().min(1).optional() });

export const LookArg = z.strictObject({
  block: z
    .string()
    .regex(/^[\w.-]+:[\w./-]+$/, "a qualified block reference, library:block")
    .optional(),
  glow: z.boolean().optional(),
  tint: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "a colour, #rrggbb")
    .optional(),
});

/** Optional fields without the `undefined` Zod puts in them (for exactOptionalPropertyTypes). */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

export function defined<T extends object>(o: T): Defined<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;
}
