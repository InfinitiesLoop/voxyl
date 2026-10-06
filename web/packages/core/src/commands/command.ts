// The command framework (web-core.md, section 1). A command is a small, deterministic
// description of intent, and every change to a project is one. Each command kind lives in its
// own file as a CommandDef: an argument schema and an apply function that writes through the
// context. Undo, ids, change reports, previews and validation are generic (see project.ts), so
// a command never deals with them.

import { z } from "zod";
import type { CellStateInput } from "../cell-state.ts";
import type { Box } from "../region.ts";
import type { SemanticRegistry } from "../semantics.ts";
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
}

/**
 * What a command may do. Reads go through `world` and `semantics`; every write goes through
 * the context, which is what makes undo and change reports work without the command's help.
 */
export interface CommandContext {
  readonly world: World;
  readonly semantics: SemanticRegistry;
  /** The cell-state id for a state, checking its semantics exist. */
  intern(state: CellStateArg): number;
  /** Sets one cell to a state id (EMPTY_ID clears it). Returns whether it changed. */
  set(x: number, y: number, z: number, id: number): boolean;
  /** Sets every cell in a box to a state id. Returns how many changed. */
  fillBox(box: Box, id: number): number;
}

export interface CommandDef<S extends z.ZodType = z.ZodType> {
  readonly kind: string;
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

/** A semantic id. Names are resolved before a command is built (by the editor or a tool). */
export const SemanticArg = z.number().int().positive();

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

/** Converts a validated state argument for the cell-state table. */
export function toStateInput(arg: CellStateArg): CellStateInput {
  return {
    ...(arg.semantic !== undefined && { semantic: arg.semantic }),
    ...(arg.rotation !== undefined && { rotation: arg.rotation }),
    ...(arg.tags !== undefined && { tags: arg.tags }),
    ...(arg.parts !== undefined && { parts: arg.parts }),
  };
}
