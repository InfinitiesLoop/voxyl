import { transformSlot } from "@voxyl/shapes";
import { z } from "zod";
import type { CellState, CellStateInput } from "../cell-state.ts";
import { SIDE_VECTORS, SideArg } from "../placement-profile.ts";
import { Region } from "../region.ts";
import { compose, matrixOf, turn } from "../rotation.ts";
import { defineCommand } from "./command.ts";

/**
 * Turns each cell of a region in place about the axis through `face` ("rotate on this face"):
 * clockwise as seen looking at that face, `turns` quarter turns (negative: anticlockwise). A
 * whole block steps on to the next rotation its placement profile allows that looks different,
 * so a stair turned about a side axis lands upside down rather than on its back, and a plain
 * cube stays as it is. A cell of parts turns as a whole, slot by slot, if every part can.
 * Cells don't move. Notes: "rotated" and "unchanged" cell counts.
 */
export const rotate = defineCommand({
  kind: "rotate",
  args: z.strictObject({
    where: Region,
    face: SideArg,
    turns: z
      .number()
      .int()
      .min(-3)
      .max(3)
      .refine((t) => t !== 0, "turns can't be 0")
      .optional(),
  }),
  apply(ctx, { where, face, turns = 1 }) {
    const v = SIDE_VECTORS[face];
    const axis = v[0] !== 0 ? 0 : v[1] !== 0 ? 1 : 2;
    const sign = v[0] + v[1] + v[2];
    // Clockwise seen from outside the face is a negative right-handed turn about its normal.
    const step = turn(axis, -sign * Math.sign(turns));
    const count = Math.abs(turns);
    const m = matrixOf(step);
    const convert = (state: CellState): number | null => {
      if (state.parts.length > 0) {
        const parts: NonNullable<CellStateInput["parts"]>[number][] = [];
        for (const p of state.parts) {
          let slot: number | null = p.slot;
          for (let i = 0; i < count && slot !== null; i++) slot = transformSlot(p.shape, slot, m);
          if (slot === null) return null;
          parts.push({ ...p, slot });
        }
        return ctx.intern({ rotation: state.rotation, tags: state.tags, parts });
      }
      const profile = ctx.placement(state.semantic);
      let r = state.rotation;
      for (let i = 0; i < count; i++) {
        const from = profile.fix(r);
        let next: number | null = null;
        let candidate = r;
        for (let k = 0; k < 4; k++) {
          candidate = compose(step, candidate);
          if (profile.allows(candidate) && profile.fix(candidate) !== from) {
            next = candidate;
            break;
          }
        }
        if (next === null) return null;
        r = next;
      }
      return ctx.intern({ semantic: state.semantic, rotation: r, tags: state.tags });
    };
    const memo = new Map<number, number | null>();
    let rotated = 0;
    let unchanged = 0;
    ctx.forEachIn(where, (x, y, z, id) => {
      let next = memo.get(id);
      if (next === undefined) {
        const state = ctx.world.states.get(id);
        next = state ? convert(state) : null;
        memo.set(id, next);
      }
      if (next === null || next === id) unchanged++;
      else {
        ctx.set(x, y, z, next);
        rotated++;
      }
    });
    ctx.note("rotated", rotated);
    ctx.note("unchanged", unchanged);
  },
});
