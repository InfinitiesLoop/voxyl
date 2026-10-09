import type { CellStateArg, Project, Region, SemanticId } from "@voxyl/core";
import { z } from "zod";
import { resolveSemantic, SemRef } from "../names.ts";
import { resolveRegion, ToolRegion } from "../region.ts";
import { editResult, MutatingFields } from "../result.ts";
import {
  checkExpansion,
  EditExtras,
  expandRegionSpecs,
  expansionNotes,
  planImages,
  RegionMover,
} from "../symmetry.ts";
import { type CommandSpec, defineTool } from "../tool.ts";

/**
 * One `set` that removes a semantic from the cells of `holding`: whole blocks clear, a cell of
 * parts keeps the parts that aren't this one. Null when no cell holds it.
 */
function removeSemantic(project: Project, holding: Region, id: SemanticId): CommandSpec | null {
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
              parts: rest.map((p) => ({ semantic: p.semantic, shape: p.shape, slot: p.slot })),
              ...(state && state.rotation !== 0 && { rotation: state.rotation }),
              ...(state && Object.keys(state.tags).length > 0 && { tags: { ...state.tags } }),
            }) - 1;
      indexOf.set(stateId, index);
    }
    flat.push(x, y, z, index);
  });
  return flat.length > 0 ? { kind: "set", args: { states, cells: flat } } : null;
}

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
    ...EditExtras,
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(_host, args, call) {
    const project = call.project;
    const where = resolveRegion(project, args.where);
    const problems: string[] = [];
    const images = planImages(args);
    let specs: CommandSpec[] = [];
    let skipped = 0;

    if (args.semantic === undefined) {
      const expanded = expandRegionSpecs(project, images, [{ kind: "clear", args: { where } }]);
      specs = expanded.specs;
      skipped = expanded.skipped;
    } else {
      const target = resolveSemantic(project, args.semantic);
      if (!target.exists || typeof target.arg !== "number") {
        problems.push(`${target.name} isn't used by any cell yet; nothing to clear.`);
      } else {
        const id: SemanticId = target.arg;
        const mover = new RegionMover(project);
        if (images.length > 1) checkExpansion(images, mover.sizeOf(where));
        // The same edit at each image's place: read the cells there before anything changes.
        for (const image of images) {
          const at = image === images[0] ? where : mover.move(image, where);
          if (at === null) continue;
          const spec = removeSemantic(project, { all: [at, { semantic: id }] }, id);
          if (spec) specs.push(spec);
        }
        if (specs.length === 0) problems.push(`No cells hold ${target.name} in that region.`);
      }
    }
    const summary = specs.length > 0 ? await call.run(specs) : null;
    return editResult(summary, { problems, ...expansionNotes(images, skipped) });
  },
});
