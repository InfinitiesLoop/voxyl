// The registry and the one entry point adapters call. callTool never throws: every outcome is
// an envelope, { ok: true, ... } or { ok: false, error: { code, message, ... } }.

import { CommandError, type HistoryEntry, RegionError, RegionTextError } from "@voxyl/core";
import { z } from "zod";
import { nearMatches } from "./names.ts";
import { generateId, makeCall } from "./run.ts";
import {
  type ToolDefinition,
  type ToolEnvelope,
  ToolError,
  type ToolFailure,
  type ToolHost,
  type ToolListing,
} from "./tool.ts";
import { build } from "./tools/build.ts";
import { clear } from "./tools/clear.ts";
import { copy } from "./tools/copy.ts";
import { describeShapes } from "./tools/describe-shapes.ts";
import { fill } from "./tools/fill.ts";
import { findBlocks } from "./tools/find-blocks.ts";
import { history } from "./tools/history.ts";
import { inspect } from "./tools/inspect.ts";
import { paletteEdit } from "./tools/palette-edit.ts";
import { paletteGet } from "./tools/palette-get.ts";
import { paste } from "./tools/paste.ts";
import { place } from "./tools/place.ts";
import { prefabEdit } from "./tools/prefab-edit.ts";
import { prefabPlace } from "./tools/prefab-place.ts";
import { prefabGet, prefabList } from "./tools/prefab-read.ts";
import { prefabSave } from "./tools/prefab-save.ts";
import { replace } from "./tools/replace.ts";
import { select } from "./tools/select.ts";
import { status } from "./tools/status.ts";
import { transform } from "./tools/transform.ts";

/** Every tool. To add one, write its file and add one line here. */
export const TOOLS: readonly ToolDefinition[] = [
  status,
  history,
  inspect,
  select,
  place,
  fill,
  clear,
  replace,
  paletteGet,
  paletteEdit,
  build,
  transform,
  copy,
  paste,
  prefabList,
  prefabGet,
  prefabSave,
  prefabPlace,
  prefabEdit,
  describeShapes,
  findBlocks,
];

const BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.name, t]));

/** Name, description and JSON Schema for each tool: what an adapter publishes. */
export function listTools(): ToolListing[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >,
    annotations: t.annotations,
  }));
}

function failure(code: string, message: string, details: object = {}): ToolFailure {
  return { ok: false, error: { code, message, ...details } };
}

/** The issues of a failed parse, flattened to {path, message} with the likeliest union branch. */
function issuesOf(issues: readonly z.core.$ZodIssue[], base: PropertyKey[] = []) {
  const out: { path: string; message: string }[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === "invalid_union") {
      // Show the branch that got furthest: the one whose first problem is deepest.
      const branches = issue.errors as z.core.$ZodIssue[][];
      const best = [...branches].sort(
        (a, b) => (b[0]?.path.length ?? 0) - (a[0]?.path.length ?? 0) || a.length - b.length,
      )[0];
      if (best && best.length > 0) {
        const nested = issuesOf(best, path);
        // A branch that only complains about a missing or unknown key tells nothing useful.
        out.push(...nested);
        continue;
      }
    }
    out.push({ path: path.map(String).join("."), message: issue.message });
  }
  return out;
}

/**
 * Runs a tool: validates the arguments, finds the project, runs the handler, and wraps what
 * comes back. Adapters call this and nothing else.
 */
export async function callTool(
  host: ToolHost,
  name: string,
  rawArgs: unknown,
): Promise<ToolEnvelope> {
  try {
    const tool = BY_NAME.get(name);
    if (!tool) {
      const suggestions = nearMatches(
        name,
        TOOLS.map((t) => t.name),
      );
      return failure(
        "unknown_tool",
        `No tool named "${name}". Did you mean ${suggestions.map((s) => `"${s}"`).join(", ")}?`,
        { suggestions },
      );
    }
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      // A misspelt key is the likeliest mistake in a union of objects: say it first.
      const issues = issuesOf(parsed.error.issues)
        .sort(
          (a, b) =>
            Number(b.message.startsWith("Unrecognized")) -
            Number(a.message.startsWith("Unrecognized")),
        )
        .slice(0, 10);
      const first = issues[0];
      const where = first && first.path !== "" ? ` at ${first.path}` : "";
      return failure(
        "bad_argument",
        `Bad arguments for ${name}${where}: ${first?.message ?? "invalid input"}`,
        { issues },
      );
    }
    const args = parsed.data as Record<string, unknown>;
    const project = host.project;
    if (!project && tool.needsProject !== false) {
      return failure(
        "no_project",
        "No project is open. Open or create a project in the editor first.",
      );
    }
    const opId = typeof args.op_id === "string" ? args.op_id : generateId(host);
    const dryRun = args.dry_run === true;
    // A repeat of a call already applied: answer without planning against the changed project.
    if (project && !dryRun && typeof args.op_id === "string" && wasApplied(project.history, opId)) {
      return {
        ok: true,
        duplicate: true,
        note: "This op_id was already applied; nothing changed this time.",
        problems: [],
      };
    }
    // A tool that runs without a project never uses its call's project.
    const call = makeCall(host, project as NonNullable<typeof project>, name, opId, dryRun);
    const result = await tool.handler(host, parsed.data, call);
    return { ok: true, ...result };
  } catch (error) {
    return errorEnvelope(error);
  }
}

/** Whether a call with this op_id already ran: its command ids are the id or id:suffix. */
function wasApplied(history: readonly HistoryEntry[], opId: string): boolean {
  return history.some((e) => e.command.id === opId || e.command.id.startsWith(`${opId}:`));
}

function errorEnvelope(error: unknown): ToolFailure {
  if (error instanceof ToolError) return failure(error.code, error.message, error.details);
  if (error instanceof RegionTextError) {
    return failure("bad_argument", error.message, { problems: error.problems });
  }
  if (error instanceof RegionError) return failure("bad_region", error.message);
  if (error instanceof CommandError) return failure("command_failed", error.message);
  return failure("internal", error instanceof Error ? error.message : String(error));
}
