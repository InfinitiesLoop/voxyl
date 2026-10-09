import { cutPiece, defaultAnchor } from "@voxyl/core";
import { z } from "zod";
import { occupied } from "../pieces.ts";
import { prefabStore, prefabSummary } from "../prefab-names.ts";
import { PosSchema, resolveRegion, ToolRegion } from "../region.ts";
import { boundsOf, MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

export const prefabSave = defineTool({
  name: "prefab_save",
  title: "Save a region as a prefab",
  description:
    "Save the cells of a region (its bounding box; empty cells stay empty) as a named prefab " +
    "the user can reuse in any project. It stores semantics (names and forms), never " +
    "materials, and remembers the project's north. `anchor` ([x,y,z] world cell inside the " +
    'region; default the floor centre, or "corner") is the cell prefab_place puts at its ' +
    "target. A name already taken needs replace:true.",
  input: z.strictObject({
    name: z.string().trim().min(1).max(80),
    where: ToolRegion,
    anchor: z.union([PosSchema, z.enum(["center", "corner"])]).optional(),
    tags: z.array(z.string().trim().min(1)).max(12).optional(),
    notes: z
      .string()
      .max(1000)
      .optional()
      .describe("What it is for and how it is meant to be used."),
    replace: z.boolean().optional().describe("Overwrite a prefab with the same name."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(host, args, call) {
    const store = prefabStore(host);
    const project = call.project;
    const cells = project.cells(resolveRegion(project, args.where));
    const b = cells.bounds();
    if (!b) throw new ToolError("bad_argument", "The region holds no cells.");
    const [ax, ay, az] = defaultAnchor([b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1]);
    const anchor: [number, number, number] =
      args.anchor === "corner"
        ? [b.x0, b.y0, b.z0]
        : Array.isArray(args.anchor)
          ? [args.anchor[0], args.anchor[1], args.anchor[2]]
          : [b.x0 + ax, b.y0 + ay, b.z0 + az];
    const inside =
      anchor[0] >= b.x0 &&
      anchor[0] <= b.x1 &&
      anchor[1] >= b.y0 &&
      anchor[1] <= b.y1 &&
      anchor[2] >= b.z0 &&
      anchor[2] <= b.z1;
    if (!inside) {
      throw new ToolError(
        "bad_argument",
        `The anchor must lie inside the region's bounds ${JSON.stringify(boundsOf(b))}.`,
      );
    }
    const piece = cutPiece(
      {
        world: project.world,
        semantics: project.semantics,
        id: project.id,
        north: project.settings.north,
      },
      cells,
      anchor,
    );
    if (!piece || occupied(piece) === 0) {
      throw new ToolError("bad_argument", "The region holds no cells.");
    }
    const taken = (await store.list()).filter(
      (p) => p.name.toLowerCase() === args.name.trim().toLowerCase(),
    );
    const out = {
      bounds: boundsOf(b),
      anchor: piece.anchor,
      north: piece.north,
      piece_semantics: piece.semantics.map((s) => s.name),
    };
    if (taken.length > 0 && args.replace !== true) {
      throw new ToolError(
        "exists",
        `A prefab named "${taken[0]?.name}" exists. Pass replace:true to overwrite it, or choose another name.`,
        { name: taken[0]?.name },
      );
    }
    if (call.dryRun) return { dry_run: true, would_replace: taken.length, ...out };
    const info = await store.save(piece, {
      name: args.name,
      ...(args.tags && { tags: args.tags }),
      ...(args.notes !== undefined && { notes: args.notes }),
    });
    for (const old of taken) await store.delete(old.id);
    return { saved: prefabSummary(info), replaced: taken.length, ...out };
  },
});
