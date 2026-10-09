// Shared pieces of tool inputs and results: the fields every mutating tool takes, bounds as
// arrays, and the small edit summary every mutating tool returns.

import type { Box } from "@voxyl/core";
import { z } from "zod";
import type { RunSummary, ToolResult } from "./tool.ts";

/** Fields every mutating tool takes. */
export const MutatingFields = {
  op_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional id for this call. Repeating a call with the same op_id changes nothing."),
  dry_run: z.boolean().optional().describe("Report what would change without changing anything."),
};

/** Most entries a result lists (rejected cells, semantics); the rest is only counted. */
export const LIST_CAP = 20;

export type BoundsArray = [number, number, number, number, number, number];

/** A box as [x0, y0, z0, x1, y1, z1] (inclusive), the form tools take boxes in. */
export function boundsOf(box: Box | null): BoundsArray | null {
  return box ? [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1] : null;
}

/** Something a tool turned down, such as a cell it couldn't place. */
export interface Rejection {
  readonly at: readonly [number, number, number];
  readonly reason: string;
  readonly detail?: string;
}

/** The common result of an edit: what changed, small. */
export function editResult(
  summary: RunSummary | null,
  extra: { rejected?: readonly Rejection[]; problems?: readonly string[] } & ToolResult = {},
): ToolResult {
  const { rejected, problems, ...rest } = extra;
  const out: ToolResult = {};
  if (summary?.dryRun) out.dry_run = true;
  if (summary?.duplicate) {
    out.duplicate = true;
    out.note = "This op_id was already applied; nothing changed this time.";
  }
  out.changed = summary?.cells ?? 0;
  out.bounds = boundsOf(summary?.bounds ?? null);
  if (summary && summary.semantics.length > 0) {
    out.semantics = summary.semantics
      .slice(0, LIST_CAP)
      .map((s) => ({ semantic: s.name, before: s.before, after: s.after }));
    if (summary.semantics.length > LIST_CAP) out.semantics_truncated = true;
  }
  if (summary && (summary.created.palettes.length > 0 || summary.created.semantics.length > 0)) {
    out.created = summary.created;
  }
  if (rejected !== undefined) {
    out.rejected_count = rejected.length;
    out.rejected = rejected.slice(0, LIST_CAP);
  }
  out.problems = problems ?? [];
  Object.assign(out, rest);
  return out;
}
