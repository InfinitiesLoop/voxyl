// What copy, move and transform share (not a command): lift a region's cells, turn and mirror
// them, and write them so their box's corner lands at a target.

import { EMPTY_ID } from "../cell-state.ts";
import type { Region } from "../region.ts";
import { type MirrorAxis, movedBox, placementMatrix } from "../transform.ts";
import type { CommandContext } from "./command.ts";

export interface RelocateArgs {
  readonly where: Region;
  /** Where the corner (lowest x, y, z) of the result lands; default: where the region's is. */
  readonly to?: readonly [number, number, number] | undefined;
  readonly turn?: number | undefined;
  readonly mirror?: MirrorAxis | undefined;
  /** Whether the region's empty cells clear the cells they land on. */
  readonly air?: boolean | undefined;
}

/**
 * Copies (or moves) a region's cells. Cells whose parts have no image under the mirror stay
 * out of the result; a move leaves them where they were. Notes: "cells" placed, "rejected".
 */
export function relocate(ctx: CommandContext, args: RelocateArgs, move: boolean): void {
  const cells = ctx.cells(args.where);
  const b = cells.bounds();
  if (!b) {
    ctx.note("cells", 0);
    return;
  }
  const m = placementMatrix(args.turn ?? 0, args.mirror);
  const moved = movedBox(
    { x0: 0, y0: 0, z0: 0, x1: b.x1 - b.x0, y1: b.y1 - b.y0, z1: b.z1 - b.z0 },
    m,
  );
  const [tx, ty, tz] = args.to ?? [b.x0, b.y0, b.z0];
  const ox = tx - moved.x0;
  const oy = ty - moved.y0;
  const oz = tz - moved.z0;
  // Read from a snapshot (a copy-on-write fork), so overlapping targets read the original.
  const source = ctx.world.fork();
  const mover = ctx.mover(m);
  const air = args.air ?? false;
  const rejected: number[] = [];
  if (move) cells.forEach((x, y, z) => void ctx.set(x, y, z, EMPTY_ID));
  let placed = 0;
  cells.forEach((x, y, z) => {
    const id = source.getId(x, y, z);
    if (id === EMPTY_ID && !air) return;
    const next = mover.move(id);
    if (next === null) {
      rejected.push(x, y, z, id);
      return;
    }
    const rx = x - b.x0;
    const ry = y - b.y0;
    const rz = z - b.z0;
    ctx.set(
      ox + (m[0] ?? 0) * rx + (m[1] ?? 0) * ry + (m[2] ?? 0) * rz,
      oy + (m[3] ?? 0) * rx + (m[4] ?? 0) * ry + (m[5] ?? 0) * rz,
      oz + (m[6] ?? 0) * rx + (m[7] ?? 0) * ry + (m[8] ?? 0) * rz,
      next,
    );
    if (next !== EMPTY_ID) placed++;
  });
  // A move leaves cells it can't place where they were, unless something landed there.
  if (move) {
    for (let i = 0; i < rejected.length; i += 4) {
      const [x = 0, y = 0, z = 0, id = 0] = rejected.slice(i, i + 4);
      if (ctx.world.getId(x, y, z) === EMPTY_ID) ctx.set(x, y, z, id);
    }
  }
  ctx.note("cells", placed);
  if (rejected.length > 0) ctx.note("rejected", rejected.length / 4);
}
