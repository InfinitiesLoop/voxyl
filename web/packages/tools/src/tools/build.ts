import { LegendValue, MAX_TEXT_CELLS, parseRegionText } from "@voxyl/core";
import { z } from "zod";
import { resolveSemantic } from "../names.ts";
import { PosSchema } from "../region.ts";
import { editResult, MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

type Legend = Record<string, z.output<typeof LegendValue>>;

/** The semantic names (and palettes) a legend uses, so a typo gets near matches. */
function checkNames(project: Parameters<typeof resolveSemantic>[0], legend: Legend): void {
  for (const value of Object.values(legend)) {
    const refs: { name: string; palette?: string | undefined }[] =
      typeof value === "string"
        ? [{ name: value }]
        : Array.isArray(value)
          ? value.map((p) => ({ name: p.semantic, palette: p.palette }))
          : [{ name: value.semantic, palette: value.palette }];
    for (const r of refs) {
      resolveSemantic(
        project,
        r.palette === undefined ? r.name : { name: r.name, palette: r.palette },
      );
    }
  }
}

export const build = defineTool({
  name: "build",
  title: "Build from text layers",
  description:
    "Place a structure from text. `layers` is a list of layers, each a list of row strings; " +
    "each character is looked up in `legend` (a semantic name; or {semantic, facing?, up?}; " +
    "or a list of parts [{semantic, slot}] for a shaped cell). '.' or space leaves the cell as " +
    "it is, '_' clears it. axis y (default) is plan view: layers go up from origin.y, rows run " +
    "north to south (+Z) from origin.z, characters west to east (+X) from origin.x. axis z is " +
    "an elevation seen from the south: layers go north to south, rows top to bottom from " +
    "origin.y, characters west to east. axis x is seen from the east: layers go west to east, " +
    "characters north to south. Read a build back the same way with inspect view layers.",
  input: z.strictObject({
    origin: PosSchema.describe("[x, y, z] of the first layer's first row's first character."),
    axis: z.enum(["x", "y", "z"]).optional(),
    legend: z.record(z.string().length(1), LegendValue),
    layers: z.array(z.union([z.string(), z.array(z.string())])).min(1),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(_host, args, call) {
    const project = call.project;
    checkNames(project, args.legend);
    const { states, cells } = parseRegionText(project, {
      origin: args.origin,
      ...(args.axis !== undefined && { axis: args.axis }),
      legend: args.legend,
      layers: args.layers,
    });
    if (cells.length === 0) {
      return editResult(null, { problems: ["The text holds no cells to set."] });
    }
    if (cells.length / 4 > MAX_TEXT_CELLS) {
      throw new ToolError("too_large", `More than ${MAX_TEXT_CELLS} cells in the text.`);
    }
    const summary = await call.run([{ kind: "set", args: { states, cells } }]);
    return editResult(summary, { cells_in_text: cells.length / 4 });
  },
});
