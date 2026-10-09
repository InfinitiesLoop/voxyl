import { z } from "zod";
import { prefabStore, prefabSummary, resolvePrefab } from "../prefab-names.ts";
import { PosSchema } from "../region.ts";
import { MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

export const prefabEdit = defineTool({
  name: "prefab_edit",
  title: "Edit or delete a prefab",
  description:
    "Change a prefab's details. `action`: rename (needs `name`), anchor (needs `anchor`, a " +
    "[x,y,z] cell counted from the prefab's lowest corner), tags (needs `tags`, replacing), " +
    "notes (needs `notes`; empty clears) or delete (permanent; needs confirm:true). Its cells " +
    "never change here; save a new prefab for that.",
  input: z.strictObject({
    prefab: z.string().trim().min(1).describe("Name (or id)."),
    action: z.enum(["rename", "anchor", "tags", "notes", "delete"]),
    name: z.string().trim().min(1).max(80).optional(),
    anchor: PosSchema.optional(),
    tags: z.array(z.string().trim().min(1)).max(12).optional(),
    notes: z.string().max(1000).optional(),
    confirm: z.boolean().optional().describe("delete: must be true."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(host, args, call) {
    const store = prefabStore(host);
    const info = await resolvePrefab(host, args.prefab);
    const need = <T>(value: T | undefined, field: string): T => {
      if (value === undefined) {
        throw new ToolError("bad_argument", `${args.action} needs \`${field}\`.`);
      }
      return value;
    };
    if (args.action === "delete") {
      if (args.confirm !== true) {
        throw new ToolError(
          "confirm_required",
          `Deleting "${info.name}" is permanent. Pass confirm:true.`,
        );
      }
      if (call.dryRun) return { dry_run: true, would_delete: prefabSummary(info) };
      await store.delete(info.id);
      return { deleted: info.name };
    }
    const changes =
      args.action === "rename"
        ? { name: need(args.name, "name") }
        : args.action === "anchor"
          ? { anchor: need(args.anchor, "anchor") }
          : args.action === "tags"
            ? { tags: need(args.tags, "tags") }
            : { notes: need(args.notes, "notes") };
    if (call.dryRun) return { dry_run: true, would_change: changes };
    try {
      return { prefab: prefabSummary(await store.update(info.id, changes)) };
    } catch (error) {
      throw new ToolError("bad_argument", error instanceof Error ? error.message : String(error));
    }
  },
});
