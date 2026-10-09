import { searchBlocks } from "@voxyl/blocks";
import { z } from "zod";
import { defineTool, ToolError } from "../tool.ts";

const MAX_LIMIT = 100;
/** How many query matches a colour search ranks (icons are baked per hit). */
const NEAR_COLOR_POOL = 5000;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const findBlocks = defineTool({
  name: "find_blocks",
  title: "Find blocks",
  description:
    "Search the block libraries for something to map a semantic to (palette_edit block " +
    "'library:block'). `query` words must all appear in the block's id or name; `library` limits " +
    "to one; `near_color` ('#rrggbb') ranks by closeness of the block's average colour and keeps " +
    "those within `tolerance` (0-441, default 60). `libraries: true` lists the libraries " +
    "instead. Results are small: ref, name, colour.",
  input: z.strictObject({
    query: z.string().optional(),
    library: z.string().optional(),
    near_color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i, "a colour, #rrggbb")
      .optional(),
    tolerance: z.number().min(0).max(442).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Default 20."),
    offset: z.number().int().min(0).optional(),
    libraries: z.boolean().optional().describe("List the libraries instead of searching."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  async handler(host, args) {
    if (!host.libraries) {
      throw new ToolError("unavailable", "This host has no block libraries.");
    }
    const libraries = await host.libraries();
    if (args.libraries === true) {
      return {
        libraries: [...libraries.values()].map((l) => ({
          id: l.id,
          name: l.name,
          blocks: Object.values(l.blocks).filter((b) => !b.hidden).length,
        })),
      };
    }
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    const base = {
      query: args.query ?? "",
      ...(args.library !== undefined && { library: args.library }),
    };
    if (args.library !== undefined && !libraries.has(args.library)) {
      throw new ToolError(
        "not_found",
        `No library "${args.library}". Libraries: ${[...libraries.keys()].join(", ") || "none"}.`,
        { kind: "library", query: args.library, suggestions: [...libraries.keys()] },
      );
    }
    if (args.near_color === undefined) {
      const { matched, hits } = searchBlocks(libraries, { ...base, limit, offset });
      return {
        matched,
        blocks: hits.map((h) => ({ block: h.ref, name: h.name, color: h.color })),
        ...(offset + hits.length < matched && { next_offset: offset + hits.length }),
        problems: libraries.size === 0 ? ["No block libraries are loaded."] : [],
      };
    }
    const target = rgb(args.near_color);
    const tolerance = args.tolerance ?? 60;
    const { hits } = searchBlocks(libraries, { ...base, limit: NEAR_COLOR_POOL });
    const ranked = hits
      .map((h) => {
        const c = rgb(h.color);
        const distance = Math.hypot(c[0] - target[0], c[1] - target[1], c[2] - target[2]);
        return { h, distance };
      })
      .filter((r) => r.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance || (a.h.ref < b.h.ref ? -1 : 1));
    const page = ranked.slice(offset, offset + limit);
    return {
      matched: ranked.length,
      blocks: page.map(({ h, distance }) => ({
        block: h.ref,
        name: h.name,
        color: h.color,
        distance: Math.round(distance),
      })),
      ...(offset + page.length < ranked.length && { next_offset: offset + page.length }),
      problems: libraries.size === 0 ? ["No block libraries are loaded."] : [],
    };
  },
});
