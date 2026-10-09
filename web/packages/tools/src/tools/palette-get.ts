import { z } from "zod";
import { resolvePalette } from "../names.ts";
import { describePalette, usage } from "../palettes.ts";
import { defineTool } from "../tool.ts";

export const paletteGet = defineTool({
  name: "palette_get",
  title: "Read palettes",
  description:
    "Without `palette`: the project's palettes (name, what each extends, how many semantics). " +
    "With a palette name: its semantics, each with the block it resolves to (block, shape, " +
    "glow, tint), how many cells use it, and `inherited_from`/`derived_from` when it comes " +
    "from a palette it extends. A semantic with no block is undecided, which is fine.",
  input: z.strictObject({
    palette: z.string().trim().min(1).optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler(_host, args, call) {
    const project = call.project;
    const registry = project.semantics;
    if (args.palette === undefined) {
      return {
        palettes: registry.palettes().map((p) => ({
          name: p.name,
          ...(p.extends !== undefined && { extends: registry.palette(p.extends).name }),
          ...(p.linked !== undefined && { linked: true }),
          semantics: registry.semanticsIn(p.id).length,
        })),
      };
    }
    const id = resolvePalette(project, args.palette);
    return { palette: describePalette(project, id, usage(project)) };
  },
});
