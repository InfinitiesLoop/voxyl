import { z } from "zod";
import { prefabStore, prefabSummary, resolvePrefab } from "../prefab-names.ts";
import { defineTool, ToolError } from "../tool.ts";

const LIST_LIMIT = 50;

export const prefabList = defineTool({
  name: "prefab_list",
  title: "List prefabs",
  description:
    "The user's prefabs (named, reusable pieces kept outside any project): name, size, cells, " +
    "tags, notes. Filter by `query` (words from name, tags or notes) or `tag`. Place one with " +
    "prefab_place; save a region with prefab_save.",
  input: z.strictObject({
    query: z.string().trim().min(1).optional(),
    tag: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  async handler(host, args) {
    let all = [...(await prefabStore(host).list())];
    if (args.tag !== undefined) {
      const tag = args.tag.toLowerCase();
      all = all.filter((p) => p.tags.includes(tag));
    }
    if (args.query !== undefined) {
      const words = args.query.toLowerCase().split(/\s+/);
      all = all.filter((p) => {
        const hay = `${p.name} ${p.tags.join(" ")} ${p.notes ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const limit = args.limit ?? LIST_LIMIT;
    const offset = args.offset ?? 0;
    return {
      matched: all.length,
      prefabs: all.slice(offset, offset + limit).map(prefabSummary),
    };
  },
});

export const prefabGet = defineTool({
  name: "prefab_get",
  title: "Describe a prefab",
  description:
    "One prefab in detail: size, anchor (the cell prefab_place puts at its target), the north " +
    "it was built facing, tags, notes, and the semantics it uses (palette and name) with " +
    "whether the open project already has them. Missing ones are created on place with the " +
    "prefab's own look, or mapped with prefab_place `remap`.",
  input: z.strictObject({ prefab: z.string().trim().min(1).describe("Name (or id).") }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  async handler(host, args) {
    const info = await resolvePrefab(host, args.prefab);
    const piece = await prefabStore(host).load(info.id);
    if (!piece) throw new ToolError("not_found", `The prefab "${info.name}" is gone.`);
    const registry = host.project?.semantics;
    const semantics = piece.semantics.map((s) => {
      const palette = registry?.palettes().find((p) => p.name === s.palette);
      const present =
        palette !== undefined && registry?.offers(palette.id).some((o) => o.name === s.name);
      return {
        name: s.name,
        palette: s.palette,
        ...(s.form?.shape !== undefined && { shape: s.form.shape }),
        ...(registry && { in_project: present === true }),
      };
    });
    return {
      prefab: {
        ...prefabSummary(info),
        anchor: piece.anchor ?? [0, 0, 0],
        north: piece.north,
        semantics,
        ...(registry && {
          missing_semantics: semantics.filter((s) => s.in_project === false).map((s) => s.name),
        }),
      },
    };
  },
});
