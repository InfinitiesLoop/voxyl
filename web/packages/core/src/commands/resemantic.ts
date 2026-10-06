import { z } from "zod";
import type { CellState } from "../cell-state.ts";
import { Region } from "../region.ts";
import { defineCommand, SemanticArg } from "./command.ts";

const SKIP = -1;

/**
 * Switches cells in a region from one semantic to another, keeping their geometry: whole
 * blocks stay whole, parts keep their shapes and slots, rotations and tags carry over. A cell
 * whose geometry doesn't fit the target's form (a whole block or a different part shape when
 * the target places a shape) is skipped and counted, unless `force` relabels it anyway.
 * Rotations the target's placement profile doesn't allow are fixed once profiles exist (step 7).
 * Notes: "switched" and "skipped" cell counts.
 */
export const resemantic = defineCommand({
  kind: "resemantic",
  args: z.strictObject({
    where: Region,
    from: SemanticArg,
    to: SemanticArg,
    force: z.boolean().optional(),
  }),
  apply(ctx, { where, from, to, force = false }) {
    const a = ctx.semantic(from);
    const b = ctx.semantic(to);
    const shape = ctx.semantics.resolve(b).form.shape;
    const convert = (state: CellState): number | null => {
      if (state.parts.length === 0) {
        if (state.semantic !== a) return null;
        if (shape !== undefined && !force) return SKIP;
        return ctx.intern({ semantic: b, rotation: state.rotation, tags: state.tags });
      }
      if (!state.parts.some((p) => p.semantic === a)) return null;
      if (
        !force &&
        shape !== undefined &&
        state.parts.some((p) => p.semantic === a && p.shape !== shape)
      ) {
        return SKIP;
      }
      return ctx.intern({
        rotation: state.rotation,
        tags: state.tags,
        parts: state.parts.map((p) => (p.semantic === a ? { ...p, semantic: b } : p)),
      });
    };
    const memo = new Map<number, number | null>();
    let switched = 0;
    let skipped = 0;
    ctx.forEachIn(where, (x, y, z, id) => {
      let next = memo.get(id);
      if (next === undefined) {
        const state = ctx.world.states.get(id);
        next = state ? convert(state) : null;
        memo.set(id, next);
      }
      if (next === null || next === id) return;
      if (next === SKIP) {
        skipped++;
        return;
      }
      ctx.set(x, y, z, next);
      switched++;
    });
    ctx.note("switched", switched);
    ctx.note("skipped", skipped);
  },
});
