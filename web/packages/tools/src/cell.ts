// What one placed cell holds, from the arguments tools take: a semantic by name, and for
// shaped semantics a slot, for turned blocks facing and up. Shaped or whole is the palette's
// business (a semantic whose form has a shape places parts), so tools share one vocabulary.

import { type CellStateArg, type SemanticArg, SIDE_VECTORS, type Side, SideArg } from "@voxyl/core";
import { ARCH_SHAPES, archRotation, isKnownShape, slotFromName, slotNames } from "@voxyl/shapes";
import { z } from "zod";
import { rotationFor, type SemanticTarget } from "./names.ts";
import { ToolError } from "./tool.ts";

/** The orientation fields that go with a semantic wherever a tool places cells. */
export const CellFields = {
  facing: SideArg.optional().describe(
    "Orientation. Whole blocks: the side the front looks toward. Roof and slope shapes: the side their low (downhill) end looks toward. North is -Z.",
  ),
  up: SideArg.optional().describe(
    "Orientation: the side the top points toward (roof shapes: up = a normal roof, down = upside down).",
  ),
  attached_to: SideArg.optional().describe(
    "Torch-like blocks: the side of the block they hold on to. down = standing on the block below (the usual); north/east/south/west = leaning out of that wall. Sets up to the opposite side.",
  ),
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
  readonly attached_to?: z.output<typeof SideArg> | undefined;
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
    if (spec.attached_to !== undefined && (spec.up !== undefined || spec.facing !== undefined)) {
      throw new ToolError("bad_argument", "Give attached_to, or facing and up, not both.");
    }
    const rotation = rotationFor(
      spec.facing,
      spec.attached_to === undefined ? spec.up : OPPOSITE[spec.attached_to],
    );
    return {
      kind: "block",
      state: {
        semantic: target.arg,
        ...(rotation !== 0 && { rotation }),
        ...(spec.tags !== undefined && { tags: spec.tags }),
      },
    };
  }
  if (spec.attached_to !== undefined) {
    ignored.add(`attached_to ignored: ${target.name} places ${shape} parts`);
  }
  const turned = spec.facing !== undefined || spec.up !== undefined;
  if (turned && (spec.slot !== undefined || !(shape in ARCH_SHAPES))) {
    ignored.add(`facing and up ignored: ${target.name} places ${shape} parts; use slot`);
  }
  if (spec.slot === undefined && turned && shape in ARCH_SHAPES) {
    const slot = archSlotFor(spec.up, spec.facing);
    if (slot >= 0)
      return { kind: "part", part: { semantic: target.arg, shape, slot }, tags: spec.tags };
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

const OPPOSITE: Record<Side, Side> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  up: "down",
  down: "up",
};

/**
 * The slot of any architecture shape whose top points `up` and whose low end (its model -Z,
 * the downhill side of a roof tile) looks `facing`. Up defaults to up, or to north when facing
 * is vertical; without facing the first turn is used. -1 when no slot matches.
 */
export function archSlotFor(up: Side | undefined, facing: Side | undefined): number {
  const wantUp = up ?? (facing === "up" || facing === "down" ? "north" : "up");
  const same = (a: readonly number[], b: readonly number[]) =>
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  for (let side = 0; side < 6; side++) {
    for (let turn = 0; turn < 4; turn++) {
      const m = archRotation(side, turn);
      if (!same([m[1], m[4], m[7]], SIDE_VECTORS[wantUp])) continue;
      if (facing !== undefined && !same([-m[2], -m[5], -m[8]], SIDE_VECTORS[facing])) continue;
      return side * 4 + turn;
    }
  }
  return -1;
}
