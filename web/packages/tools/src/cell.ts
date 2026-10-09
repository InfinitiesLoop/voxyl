// What one placed cell holds, from the arguments tools take: a semantic by name, and for
// shaped semantics a slot, for turned blocks facing and up. Shaped or whole is the palette's
// business (a semantic whose form has a shape places parts), so tools share one vocabulary.

import { type CellStateArg, type SemanticArg, SideArg } from "@voxyl/core";
import { isKnownShape, slotFromName, slotNames } from "@voxyl/shapes";
import { z } from "zod";
import { rotationFor, type SemanticTarget } from "./names.ts";
import { ToolError } from "./tool.ts";

/** The orientation fields that go with a semantic wherever a tool places cells. */
export const CellFields = {
  facing: SideArg.optional().describe(
    "Whole blocks: the side the block's front looks toward (north south east west up down).",
  ),
  up: SideArg.optional().describe("Whole blocks: the side the block's top points toward."),
  slot: z
    .union([z.string(), z.number().int().min(0)])
    .optional()
    .describe(
      'Shaped semantics: where the part sits, by name ("north", "south-east", "down-north-west", "center-y", "up=north turn=1") or number.',
    ),
  shape: z
    .string()
    .optional()
    .describe("Part shape, when it isn't the semantic's own (e.g. edge1, face4, roof_tile)."),
  tags: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Extra block properties, kept with the cell."),
};

export type Tags = Record<string, string | number | boolean>;

export interface CellFieldValues {
  readonly facing?: z.output<typeof SideArg> | undefined;
  readonly up?: z.output<typeof SideArg> | undefined;
  readonly slot?: string | number | undefined;
  readonly shape?: string | undefined;
  readonly tags?: Tags | undefined;
}

export interface PartPlan {
  readonly semantic: SemanticArg;
  readonly shape: string;
  readonly slot: number;
}

export type CellPlan =
  | { readonly kind: "block"; readonly state: CellStateArg }
  | { readonly kind: "part"; readonly part: PartPlan; readonly tags: Tags | undefined }
  | { readonly kind: "reject"; readonly reason: string; readonly detail: string };

const quoted = (names: readonly string[]) => names.map((s) => `"${s}"`).join(", ");

/**
 * Plans one cell. A whole block takes facing and up; a part takes a slot. Arguments that don't
 * apply are added to `ignored`, so a result can say so once.
 */
export function planCell(
  target: SemanticTarget,
  spec: CellFieldValues,
  ignored: Set<string>,
): CellPlan {
  if (spec.shape !== undefined && !isKnownShape(spec.shape)) {
    throw new ToolError("bad_argument", `Unknown shape "${spec.shape}".`, { shape: spec.shape });
  }
  const shape = spec.shape ?? target.shape;
  if (shape === undefined) {
    if (spec.slot !== undefined) {
      ignored.add(`slot ignored: ${target.name} places whole blocks`);
    }
    const rotation = rotationFor(spec.facing, spec.up);
    return {
      kind: "block",
      state: {
        semantic: target.arg,
        ...(rotation !== 0 && { rotation }),
        ...(spec.tags !== undefined && { tags: spec.tags }),
      },
    };
  }
  if (spec.facing !== undefined || spec.up !== undefined) {
    ignored.add(`facing and up ignored: ${target.name} places ${shape} parts; use slot`);
  }
  if (spec.slot === undefined) {
    return {
      kind: "reject",
      reason: "slot_required",
      detail: `${target.name} places ${shape} parts; give a slot such as ${quoted(slotNames(shape).slice(0, 3))}`,
    };
  }
  const slot = slotFromName(shape, spec.slot);
  if (slot < 0) {
    return {
      kind: "reject",
      reason: "bad_slot",
      detail: `${shape} has no slot "${spec.slot}"; try ${quoted(slotNames(shape).slice(0, 6))}`,
    };
  }
  return { kind: "part", part: { semantic: target.arg, shape, slot }, tags: spec.tags };
}
