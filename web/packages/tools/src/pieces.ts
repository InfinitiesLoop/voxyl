// Placing a piece (the clipboard, a prefab) the way tools mean it: the anchor lands on `at`,
// turned and mirrored, optionally copied through symmetry and repeat. Shared by `paste` and
// `prefab_place`.

import {
  type Piece,
  type Project,
  placementMatrix,
  type SemanticArg,
  turnsBetween,
} from "@voxyl/core";
import { z } from "zod";
import { resolveSemantic, type SemRef } from "./names.ts";
import { PosSchema } from "./region.ts";
import { editResult } from "./result.ts";
import {
  checkExpansion,
  EditExtras,
  type Image,
  isExpanded,
  movePos,
  planImages,
} from "./symmetry.ts";
import { type RunSummary, type ToolCall, ToolError, type ToolResult } from "./tool.ts";

/** The fields that say how a piece sits where it is put. */
export const PlaceFields = {
  at: PosSchema.describe("[x, y, z] where the piece's anchor lands."),
  turn: z
    .number()
    .int()
    .min(-3)
    .max(3)
    .optional()
    .describe("Quarter turns clockwise seen from above, about the anchor."),
  mirror: z.enum(["x"]).optional().describe("Mirror east/west, after turning."),
  air: z.boolean().optional().describe("The piece's empty cells clear what they land on."),
  ...EditExtras,
};

export interface PlaceArgs {
  readonly at: readonly [number, number, number];
  readonly turn?: number | undefined;
  readonly mirror?: "x" | undefined;
  readonly air?: boolean | undefined;
  readonly symmetry?: z.output<typeof EditExtras.symmetry>;
  readonly repeat?: z.output<typeof EditExtras.repeat>;
}

/** The turn and mirror that give an image's move after a placement, or null if none does. */
function composed(
  image: Image,
  north: number,
  turn: number,
  mirror: "x" | undefined,
): { turn: number; mirror: "x" | undefined } | null {
  const want = (m: readonly number[]) => {
    const out = new Array<number>(9).fill(0);
    const base = placementMatrix(turn + north, mirror);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        for (let k = 0; k < 3; k++)
          out[r * 3 + c] = (out[r * 3 + c] ?? 0) + (m[r * 3 + k] ?? 0) * (base[k * 3 + c] ?? 0);
    return out;
  };
  const target = want(image.m).join(",");
  for (let t = 0; t < 4; t++)
    for (const m of [undefined, "x" as const]) {
      if (placementMatrix(t, m).join(",") === target)
        return { turn: (t - north + 4) % 4, mirror: m };
    }
  return null;
}

/** Pastes a piece through every image of the placement; one undo step. */
export async function placePiece(
  call: ToolCall,
  piece: Piece,
  args: PlaceArgs,
  extra: { map?: Record<string, SemanticArg> } = {},
): Promise<{ summary: RunSummary; copies: number; skipped: number }> {
  const project = call.project;
  const images = planImages(args);
  if (isExpanded(images)) {
    checkExpansion(images, piece.size[0] * piece.size[1] * piece.size[2]);
  }
  const north = turnsBetween(piece.north, project.settings.north);
  const specs = [];
  let skipped = 0;
  for (const image of images) {
    const how = composed(image, north, args.turn ?? 0, args.mirror);
    if (how === null) {
      skipped++;
      continue;
    }
    specs.push({
      kind: "paste",
      args: {
        piece,
        at: movePos(image, args.at),
        ...(how.turn !== 0 && { turn: how.turn }),
        ...(how.mirror && { mirror: how.mirror }),
        ...(args.air && { air: true }),
        ...(extra.map && Object.keys(extra.map).length > 0 && { map: extra.map }),
      },
    });
  }
  const summary = await call.run(specs);
  return { summary, copies: specs.length, skipped };
}

/** Piece semantic numbers (1-based) for a remap given by names; unknown names are an error. */
export function remapOf(
  project: Project,
  piece: Piece,
  remap: Record<string, z.output<typeof SemRef>> | undefined,
): Record<string, SemanticArg> {
  const out: Record<string, SemanticArg> = {};
  for (const [from, to] of Object.entries(remap ?? {})) {
    const numbers = piece.semantics.flatMap((s, i) => (s.name === from ? [i + 1] : []));
    if (numbers.length === 0) {
      throw new ToolError("bad_argument", `The piece has no semantic named "${from}".`, {
        piece_semantics: piece.semantics.map((x) => x.name),
      });
    }
    const target = resolveSemantic(project, to);
    for (const n of numbers) out[String(n)] = target.arg;
  }
  return out;
}

/** The result fields of a placement. */
export function placeResult(
  summary: RunSummary,
  info: { copies: number; skipped: number },
  extra: ToolResult = {},
): ToolResult {
  const rejected = summary.totals.rejected ?? 0;
  const problems: string[] = [];
  if (rejected > 0)
    problems.push(`${rejected} part(s) have no image under that turn or mirror and were left out.`);
  if (info.skipped > 0)
    problems.push(`${info.skipped} copy(ies) skipped: no turn/mirror reproduces that symmetry.`);
  return editResult(summary, {
    ...(info.copies > 1 && { copies: info.copies }),
    ...(Number(summary.notes.turned ?? 0) !== 0 && {
      turned_for_north: Number(summary.notes.turned),
    }),
    ...(rejected > 0 && { rejected_count: rejected }),
    problems,
    ...extra,
  });
}

/** Cells of a piece that hold something (air does not count). */
export function occupied(piece: Piece): number {
  let n = 0;
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    const k = piece.cells[r] ?? 0;
    if (k !== 0 && piece.states[k - 1] !== null) n += piece.cells[r + 1] ?? 0;
  }
  return n;
}
