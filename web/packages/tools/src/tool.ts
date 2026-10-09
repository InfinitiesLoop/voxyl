// The shape of a tool and of the host it runs against (.plans/web-tools.md). A tool is a name,
// an input schema and a handler; it never sees the worker, the relay or WebMCP, only a
// ToolHost, so it tests in Node with an in-memory host.

import type { Box, Project, SemanticChange } from "@voxyl/core";
import type { z } from "zod";

/** What a tool needs from whoever runs it: the core project plus the few things outside it. */
export interface ToolHost {
  /** The open project, or null when none is open. Read on every call, so it may change. */
  readonly project: Project | null;
  /** Whether a person's editor tab is attached (the status tool reports it). */
  readonly editorAttached?: boolean;
  /** A fresh unique id for a call that didn't name its own op_id. Default: random. */
  newId?(): string;
  /**
   * Called (and awaited) after a tool changed the project, so the host can persist it or tell
   * its views. Not called for dry runs.
   */
  changed?(
    project: Project,
    info: { tool: string; commandIds: readonly string[] },
  ): void | Promise<void>;
  // Block libraries, the clipboard and the prefab and palette stores join here, optional and
  // async, as the tools that need them land (find_blocks, transform, prefab_*, palette_edit).
}

/** MCP-style hints about what a tool does to the world. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
}

/** A command a tool wants run: core's kind and arguments. */
export interface CommandSpec {
  readonly kind: string;
  readonly args: unknown;
}

/** What running a tool's commands did, summed over them. */
export interface RunSummary {
  /** Nothing ran for real: the commands ran on a fork (dry_run). */
  readonly dryRun: boolean;
  /** The op_id was already applied: nothing changed this time. */
  readonly duplicate: boolean;
  /** The command ids used. */
  readonly ids: readonly string[];
  /** Cells changed (summed over the commands; tools keep their commands' cells apart). */
  readonly cells: number;
  readonly bounds: Box | null;
  readonly semantics: readonly SemanticChange[];
  /** Names of the palettes and semantics the commands created. */
  readonly created: { readonly palettes: readonly string[]; readonly semantics: readonly string[] };
  /** Figures the commands added ("switched": 12), the last command's winning. */
  readonly notes: Readonly<Record<string, number | string>>;
  /** The project as it is after (the fork, for a dry run): read it for selection and the like. */
  readonly after: Project;
}

/** The per-call context a handler gets next to the host and its arguments. */
export interface ToolCall {
  readonly tool: string;
  /** The open project (tools that don't need one never run without it; others get a throw). */
  readonly project: Project;
  /** The call's id: its op_id, or generated. Command ids derive from it. */
  readonly opId: string;
  readonly dryRun: boolean;
  /**
   * Runs commands as this call: ids from the op_id, source "Claude", label "Claude: <tool>"
   * and one group, so several commands undo as one step. A dry run applies them to a fork.
   * Several commands are validated on a fork first, so they apply completely or not at all.
   * `suffix` names the id of a single command in a call that runs several (undo steps).
   */
  run(specs: readonly CommandSpec[], suffix?: string): Promise<RunSummary>;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  /** snake_case, stable: it is the name agents call. */
  readonly name: string;
  readonly title: string;
  /** Agent-facing: what it does, units, directions, the one gotcha. Keep it short. */
  readonly description: string;
  readonly input: S;
  readonly annotations: ToolAnnotations;
  /** False for tools that answer without a project (status). Default true. */
  readonly needsProject?: boolean;
  /** Returns the result fields (callTool adds `ok: true`); throws ToolError for failures. */
  handler(host: ToolHost, args: z.output<S>, call: ToolCall): Promise<ToolResult> | ToolResult;
}

/** Declares a tool; the schema's output types the handler's arguments. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export type ToolResult = Record<string, unknown>;

/** A failure with a code an agent can act on. */
export class ToolError extends Error {
  override readonly name = "ToolError";
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type ToolFailure = {
  ok: false;
  error: { code: string; message: string } & Record<string, unknown>;
};
export type ToolSuccess = { ok: true } & Record<string, unknown>;
/** What callTool always resolves to. */
export type ToolEnvelope = ToolSuccess | ToolFailure;

/** What an adapter needs to list a tool. */
export interface ToolListing {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: ToolAnnotations;
}
