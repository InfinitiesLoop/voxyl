import { SideArg } from "@voxyl/core";
import {
  ARCH_SHAPES,
  ARCH_SLOTS,
  isKnownShape,
  MICRO_SHAPES,
  microSlotCount,
  shapeName,
  slotNames,
} from "@voxyl/shapes";
import { z } from "zod";
import { archSlotFor } from "../cell.ts";
import { notFound } from "../names.ts";
import { defineTool, ToolError } from "../tool.ts";

export const describeShapes = defineTool({
  name: "describe_shapes",
  title: "Describe part shapes",
  description:
    "Without `shape`: every part shape a semantic can place (id, name, family, thickness). " +
    "With a shape id: its slots by name. Microblock slots name the side(s) the part sits on " +
    '("north", "south-east", "down-north-west", "center-y"). Roof and slope shapes take a whole ' +
    'cell in one of 24 orientations ("up=north turn=1"); pass `up` and `facing` to get the slot ' +
    "for a top pointing `up` and a low (downhill) end looking `facing`.",
  input: z.strictObject({
    shape: z.string().trim().min(1).optional(),
    up: SideArg.optional(),
    facing: SideArg.optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  handler(_host, args) {
    if (args.shape === undefined) {
      return {
        shapes: [
          ...Object.entries(MICRO_SHAPES).map(([id, s]) => ({
            shape: id,
            name: s.name,
            family: s.family,
            thickness_eighths: s.size,
            slots: microSlotCount(id),
          })),
          ...Object.keys(ARCH_SHAPES).map((id) => ({
            shape: id,
            name: shapeName(id),
            family: "architecture",
            slots: ARCH_SLOTS,
          })),
        ],
      };
    }
    if (!isKnownShape(args.shape)) {
      throw notFound("shape", args.shape, [
        ...Object.keys(MICRO_SHAPES),
        ...Object.keys(ARCH_SHAPES),
      ]);
    }
    const arch = args.shape in ARCH_SHAPES;
    const micro = MICRO_SHAPES[args.shape];
    const out: Record<string, unknown> = {
      shape: args.shape,
      name: shapeName(args.shape),
      family: arch ? "architecture" : micro?.family,
      ...(micro && { thickness_eighths: micro.size }),
      slots: slotNames(args.shape),
    };
    if (args.up !== undefined || args.facing !== undefined) {
      if (!arch) {
        throw new ToolError("bad_argument", "up and facing only apply to roof and slope shapes.");
      }
      const slot = archSlotFor(args.up, args.facing);
      if (slot < 0) throw new ToolError("bad_argument", "No orientation has that up and facing.");
      out.slot = slotNames(args.shape)[slot];
    }
    return out;
  },
});
