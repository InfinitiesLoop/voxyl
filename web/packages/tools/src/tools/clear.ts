import type { CellStateArg, Region, SemanticId } from "@voxyl/core";
import { z } from "zod";
import { resolveSemantic, SemRef } from "../names.ts";
import { resolveRegion, ToolRegion } from "../region.ts";
import { editResult, MutatingFields } from "../result.ts";
import { type CommandSpec, defineTool } from "../tool.ts";

export const clear = defineTool({
  name: "clear",
  title: "Clear cells",
  description:
    "Empty the cells of a region. With `semantic`, remove only that semantic: whole blocks of " +
    "it go, and in a cell of parts only its parts go, so other parts stay. Counts the cells " +
    "changed.",
  input: z.strictObject({
    where: ToolRegion,
    semantic: SemRef.optional().describe("Only remove this semantic from the region."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(_host, args, call) {
    const project = call.project;
    const where = resolveRegion(project, args.where);
    const problems: string[] = [];
    let spec: CommandSpec | null = { kind: "clear", args: { where } };

    if (args.semantic !== undefined) {
      const target = resolveSemantic(project, args.semantic);
      if (!target.exists || typeof target.arg !== "number") {
        problems.push(`${target.name} isn't used by any cell yet; nothing to clear.`);
        spec = null;
      } else {
        const id: SemanticId = target.arg;
        const holding: Region = { all: [where, { semantic: id }] };
        // One `set`: whole blocks clear, a cell of parts keeps the parts that aren't this one.
        const states: (CellStateArg | null)[] = [null];
        const indexOf = new Map<number, number>();
        const flat: number[] = [];
        project.forEachIn(holding, (x, y, z, stateId) => {
          let index = indexOf.get(stateId);
          if (index === undefined) {
            const state = project.world.states.get(stateId);
            const rest = state?.parts.filter((p) => p.semantic !== id) ?? [];
            index =
              rest.length === 0
                ? 0
                : states.push({
                    parts: rest.map((p) => ({
                      semantic: p.semantic,
                      shape: p.shape,
                      slot: p.slot,
                    })),
                    ...(state && state.rotation !== 0 && { rotation: state.rotation }),
                    ...(state && Object.keys(state.tags).length > 0 && { tags: { ...state.tags } }),
                  }) - 1;
            indexOf.set(stateId, index);
          }
          flat.push(x, y, z, index);
        });
        spec = flat.length > 0 ? { kind: "set", args: { states, cells: flat } } : null;
        if (spec === null) problems.push(`No cells hold ${target.name} in that region.`);
      }
    }
    const summary = spec ? await call.run([spec]) : null;
    return editResult(summary, { problems });
  },
});
