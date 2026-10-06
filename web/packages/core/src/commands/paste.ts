import { z } from "zod";
import { EMPTY_ID } from "../cell-state.ts";
import { stateInput } from "../format/state-json.ts";
import { forEachPieceCell, importSemantics, type Piece, PieceArg } from "../piece.ts";
import { PosArg } from "../region.ts";
import { PlacementArgs, placementMatrix, StateMover, turnsBetween } from "../transform.ts";
import { CommandError, defineCommand, SemanticArg } from "./command.ts";

/** A prefab's content hash (see prefabHash). */
export const HashArg = z.string().regex(/^[0-9a-f]{16}$/, "a prefab hash");

/**
 * Places a piece: the clipboard's cells carried inline, or a prefab named by its content hash
 * (so a later edit to the prefab can't change what this command meant). The piece's anchor
 * lands at `at`, and the piece turns about it: first so its north matches the project's, then
 * by `turn` and `mirror`. Its semantics map into the project by origin id or by palette and
 * name, and missing ones are created with the piece's looks (see importSemantics); `map`
 * overrides that per piece semantic (1-based). With `air`, the piece's empty cells clear what
 * they land on. Notes: "cells", "turned" (quarter turns for north), "rejected".
 */
export const paste = defineCommand({
  kind: "paste",
  args: z
    .strictObject({
      piece: PieceArg.optional(),
      prefab: HashArg.optional(),
      at: PosArg,
      ...PlacementArgs,
      air: z.boolean().optional(),
      map: z.record(z.string().regex(/^[1-9]\d*$/), SemanticArg).optional(),
    })
    .refine((a) => (a.piece === undefined) !== (a.prefab === undefined), {
      message: "give a piece or a prefab, not both",
    }),
  apply(ctx, args) {
    // Zod leaves undefined in optional fields; importSemantics strips them from forms and looks.
    const piece = (args.piece as Piece | undefined) ?? ctx.prefab(args.prefab ?? "");
    const semantics = importSemantics(piece, ctx.semantics, ctx.projectId, (n) => {
      const ref = args.map?.[String(n)];
      return ref === undefined ? undefined : ctx.semantic(ref);
    });
    const semanticOf = (n: number): number => {
      const s = semantics[n - 1];
      if (s === undefined) throw new CommandError(`Piece semantic ${n} doesn't exist`);
      return s;
    };
    const north = turnsBetween(piece.north, ctx.settings.north);
    const m = placementMatrix((args.turn ?? 0) + north, args.mirror);
    const mover = new StateMover(ctx.world.states, m);
    const ids = piece.states.map((s) =>
      s === null ? EMPTY_ID : mover.move(ctx.intern(stateInput(s, semanticOf))),
    );
    const [ax, ay, az] = piece.anchor ?? [0, 0, 0];
    const [tx, ty, tz] = args.at;
    const air = args.air ?? false;
    let placed = 0;
    let rejected = 0;
    try {
      forEachPieceCell(piece, (x, y, z, n) => {
        const id = ids[n - 1];
        if (id === EMPTY_ID && !air) return;
        if (id === null || id === undefined) {
          rejected++;
          return;
        }
        const rx = x - ax;
        const ry = y - ay;
        const rz = z - az;
        ctx.set(
          tx + (m[0] ?? 0) * rx + (m[1] ?? 0) * ry + (m[2] ?? 0) * rz,
          ty + (m[3] ?? 0) * rx + (m[4] ?? 0) * ry + (m[5] ?? 0) * rz,
          tz + (m[6] ?? 0) * rx + (m[7] ?? 0) * ry + (m[8] ?? 0) * rz,
          id,
        );
        if (id !== EMPTY_ID) placed++;
      });
    } catch (error) {
      if (error instanceof RangeError) throw new CommandError(error.message);
      throw error;
    }
    ctx.note("cells", placed);
    if (north !== 0) ctx.note("turned", north);
    if (rejected > 0) ctx.note("rejected", rejected);
  },
});
