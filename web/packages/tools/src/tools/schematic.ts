// Schematica export and a read-back of a .schematic file. Semantics become Minecraft blocks
// only here, and only in the file: anything without a confirmed identity is left out and named
// in the report. The bytes go to the editor as a download; the agent gets the report.

import {
  CellSet,
  cutPiece,
  MAX_REGION_CELLS,
  type Piece,
  type Project,
  regionStats,
} from "@voxyl/core";
import {
  builtinIdentity,
  type ExportReport,
  exportSchematic,
  type IdentityResolver,
  materialRows,
  materialText,
  planExport,
  probeSchematic,
} from "@voxyl/schematic";
import { z } from "zod";
import { notFound } from "../names.ts";
import { resolvePrefab } from "../prefab-names.ts";
import { resolveRegion, ToolRegion } from "../region.ts";
import { OpFields } from "../result.ts";
import { defineTool, ToolError, type ToolHost, type ToolResult } from "../tool.ts";

const MAX_PROBE_BYTES = 8_000_000;
const LIST_CAP = 30;

const Exclude = z
  .array(z.string().trim().min(1))
  .max(200)
  .optional()
  .describe("Semantic names to leave out of the file.");

async function resolver(host: ToolHost): Promise<IdentityResolver> {
  return host.identify ? await host.identify() : builtinIdentity;
}

function scope(project: Project) {
  return {
    world: project.world,
    semantics: project.semantics,
    id: project.id,
    north: project.settings.north,
  };
}

/** The piece a region (or the whole build) exports. */
function pieceOf(project: Project, where: z.output<typeof ToolRegion> | undefined): Piece {
  let cells: CellSet;
  if (where) {
    cells = project.cells(resolveRegion(project, where));
  } else {
    const bounds = regionStats(project).bounds;
    if (!bounds) throw new ToolError("bad_region", "The build is empty.");
    const volume =
      (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1) * (bounds.z1 - bounds.z0 + 1);
    if (volume > MAX_REGION_CELLS) {
      throw new ToolError(
        "too_large",
        "The build's box is too big to export whole. Pass where to export part of it.",
        { cells: volume, limit: MAX_REGION_CELLS },
      );
    }
    cells = CellSet.ofBox(bounds);
  }
  const bounds = cells.bounds();
  if (!bounds || cells.size === 0) throw new ToolError("bad_region", "The region holds no cells.");
  const volume =
    (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1) * (bounds.z1 - bounds.z0 + 1);
  if (volume > MAX_REGION_CELLS) {
    throw new ToolError("too_large", "That region is too big to export.", {
      cells: volume,
      limit: MAX_REGION_CELLS,
    });
  }
  const piece = cutPiece(scope(project), cells);
  if (!piece) throw new ToolError("bad_region", "The region holds no cells.");
  return piece;
}

/** Piece semantic numbers (1-based) for the names to leave out. */
function excludeOf(piece: Piece, names: readonly string[] | undefined): Set<number> {
  const exclude = new Set<number>();
  if (!names) return exclude;
  const known = piece.semantics.map((s) => s.name);
  for (const name of names) {
    const exact = piece.semantics.findIndex((s) => s.name === name);
    const index =
      exact >= 0
        ? exact
        : piece.semantics.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (index < 0) throw notFound("semantic", name, known);
    exclude.add(index + 1);
  }
  return exclude;
}

function capped(record: Readonly<Record<string, number>>): Record<string, number> | undefined {
  const entries = Object.entries(record);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.slice(0, LIST_CAP));
}

function reportOf(report: ExportReport, materials: string): ToolResult {
  const problems: string[] = [];
  if (Object.keys(report.undecided).length > 0) {
    problems.push("Some semantics have no block yet; those cells were left out.");
  }
  if (Object.keys(report.unmapped).length > 0) {
    problems.push("Some blocks have no Minecraft identity; those cells were left out.");
  }
  if (Object.keys(report.unsupported).length > 0) {
    problems.push("Some part shapes have no schematic equivalent; those parts were left out.");
  }
  const lines = materials.split("\n").filter((line) => line !== "");
  const field = (record: Readonly<Record<string, number>>) => capped(record);
  return {
    size: report.size,
    cells_written: report.cellsWritten,
    cells_kept: report.cellsKept,
    cells_excluded: report.cellsExcluded,
    distinct_blocks: report.distinctBlocks,
    turned_degrees: report.turnedDegrees,
    north: report.north,
    tile_entities: report.tileEntities,
    empty_part_cells: report.emptyPartCells,
    ...(field(report.mapped) && { mapped: field(report.mapped) }),
    ...(field(report.undecided) && { undecided: field(report.undecided) }),
    ...(field(report.unmapped) && { unmapped: field(report.unmapped) }),
    ...(field(report.unsupported) && { unsupported: field(report.unsupported) }),
    ...(field(report.assumed) && { assumed: field(report.assumed) }),
    ...(field(report.sawWarnings) && { saw_warnings: field(report.sawWarnings) }),
    ...(lines.length > 0 && {
      materials: lines.slice(0, LIST_CAP).join("\n"),
      ...(lines.length > LIST_CAP && { materials_truncated: true }),
    }),
    problems,
  };
}

function fileName(name: string): string {
  const clean = name.replace(/[^\w .()-]+/g, "").trim() || "build";
  return clean.toLowerCase().endsWith(".schematic") ? clean : `${clean}.schematic`;
}

export const exportSchematicTool = defineTool({
  name: "export_schematic",
  title: "Export a Schematica schematic",
  description:
    "Export the open build, a region, or a saved prefab to a Schematica .schematic. The file " +
    "downloads in the editor; this result is the report (what was written, and what was left " +
    "out: undecided semantics, blocks with no Minecraft identity, shapes with no equivalent). " +
    "North is turned so the build's north lands on the game's north. dry_run reports only. " +
    "Omit where and prefab to export the whole build.",
  input: z.strictObject({
    where: ToolRegion.optional().describe("Cells to export. Omit for the whole build."),
    prefab: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Export this saved prefab instead of the open project."),
    exclude: Exclude,
    trim: z
      .boolean()
      .optional()
      .describe("Shrink the file to the cells that are kept. Default true."),
    ...OpFields,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  async handler(host, args) {
    if (args.where && args.prefab) {
      throw new ToolError("bad_argument", "Pass where or prefab, not both.");
    }
    const identify = await resolver(host);
    let piece: Piece;
    let filename: string;
    if (args.prefab) {
      const found = await resolvePrefab(host, args.prefab);
      const loaded = await host.prefabs?.load(found.id);
      if (!loaded) {
        throw new ToolError("not_found", `Prefab "${found.name}" has no cells.`, {
          kind: "prefab",
        });
      }
      piece = loaded;
      filename = fileName(found.name);
    } else {
      if (!host.project) {
        throw new ToolError("no_project", "No project is open. Open one, or pass prefab.");
      }
      piece = pieceOf(host.project, args.where);
      filename = fileName(host.project.settings.name || "build");
    }
    const exclude = excludeOf(piece, args.exclude);
    const trim = args.trim !== false;
    const plan = planExport(piece, { identify, exclude, trim, dryRun: true });
    const materials = materialText(materialRows(piece, identify, exclude));
    const fields = { filename, ...reportOf(plan.report, materials) };
    if (plan.report.problem) {
      throw new ToolError("bad_region", plan.report.problem, fields);
    }
    if (args.dry_run) return { ...fields, dry_run: true };
    if (!host.effect) {
      throw new ToolError(
        "unavailable",
        "This host has no editor to download the schematic in.",
        fields,
      );
    }
    const { bytes } = await exportSchematic(piece, { identify, exclude, trim });
    host.effect({ kind: "download", filename, bytes });
    return fields;
  },
});

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  if (clean.length === 0) throw new ToolError("bad_argument", "bytes is empty.");
  if (Math.floor((clean.length * 3) / 4) > MAX_PROBE_BYTES) {
    throw new ToolError("too_large", `A probe reads at most ${MAX_PROBE_BYTES} bytes.`, {
      limit: MAX_PROBE_BYTES,
    });
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new ToolError("bad_argument", "bytes is not base64.");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export const probeSchematicTool = defineTool({
  name: "probe_schematic",
  title: "Inspect a schematic file",
  description:
    "Read a Schematica .schematic (base64) without importing it: its size, which registry " +
    "names it contains, and how many cells of each. Air is left out of the histogram.",
  input: z.strictObject({
    bytes: z.string().min(1).describe("The .schematic file, base64."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  async handler(_host, args) {
    const decoded = decodeBase64(args.bytes);
    const probed = await probeSchematic(decoded);
    if (!probed) throw new ToolError("bad_file", "That is not a Schematica .schematic file.");
    const histogram = Object.entries(probed.histogram)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LIST_CAP);
    const blocks = Object.values(probed.histogram).reduce((sum, n) => sum + n, 0);
    return {
      size: probed.size,
      blocks,
      tile_entities: probed.tileEntities.length,
      mapping: Object.keys(probed.mapping).length,
      histogram: Object.fromEntries(histogram),
      ...(Object.keys(probed.histogram).length > LIST_CAP && { histogram_truncated: true }),
    };
  },
});
