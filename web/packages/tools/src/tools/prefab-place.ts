import { z } from "zod";
import { SemRef } from "../names.ts";
import { PlaceFields, placePiece, placeResult, remapOf } from "../pieces.ts";
import { prefabStore, resolvePrefab } from "../prefab-names.ts";
import { MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

export const prefabPlace = defineTool({
  name: "prefab_place",
  title: "Place a prefab",
  description:
    "Place a prefab with its anchor at `at`, optionally `turn`ed (quarter turns clockwise from " +
    "above) and `mirror`ed. North is north: a prefab built facing another north is turned to " +
    "this project's first. Its semantics resolve through the project's palettes; missing ones " +
    "are created with the prefab's own look (listed as `missing_semantics`), or mapped with " +
    '`remap` {"PrefabSemantic": "ProjectSemantic"}. symmetry and repeat stamp copies (a row ' +
    "of pillars in one call). One undo step.",
  input: z.strictObject({
    prefab: z.string().trim().min(1).describe("Name (or id)."),
    ...PlaceFields,
    remap: z.record(z.string(), SemRef).optional(),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async handler(host, args, call) {
    const info = await resolvePrefab(host, args.prefab);
    const piece = await prefabStore(host).load(info.id);
    if (!piece) throw new ToolError("not_found", `The prefab "${info.name}" is gone.`);
    const map = remapOf(call.project, piece, args.remap);
    const placed = await placePiece(call, piece, args, { map });
    return placeResult(placed.summary, placed, {
      prefab: info.name,
      missing_semantics: placed.summary.created.semantics,
    });
  },
});
