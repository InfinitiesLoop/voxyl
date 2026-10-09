// The shape of a tool and of the host it runs against (.plans/web-tools.md). A tool is a name,
// an input schema and a handler; it never sees the worker, the relay or WebMCP, only a
// ToolHost, so it tests in Node with an in-memory host.

import type { Libraries } from "@voxyl/blocks";
import type { Box, Piece, Project, SemanticChange, SharedPalette } from "@voxyl/core";
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
  /** The block libraries available to this project (find_blocks, block checks). Async: they load. */
  libraries?(): Promise<Libraries> | Libraries;
  /** The clipboard: one piece, kept across projects. */
  readonly clipboard?: ClipboardPort;
  /** The user's shared palettes, kept outside any project. */
  readonly sharedPalettes?: SharedPalettesPort;
  /** The user's prefabs, kept outside any project. */
  readonly prefabs?: PrefabsPort;
  /** The saved projects, and saving, creating and deleting them. */
  readonly projects?: ProjectsPort;
  /**
   * Asks the tab to do something only it can (open a project, take a picture, move the camera)
   * once this call has returned: the effects ride on the reply and the tab runs them in order,
   * so a tool never waits on the tab. Hosts without a tab leave this out.
   */
  effect?(effect: TabEffect): void;
}

/** What a tool asks the tab to do after it returns (see ToolHost.effect). */
export type TabEffect =
  | { readonly kind: "open_project"; readonly id: string }
  | { readonly kind: "project_saved"; readonly id: string }
  | { readonly kind: "project_deleted"; readonly id: string };

/** A saved project as a list shows it. */
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly cells: number;
  readonly savedAt: number;
}

/**
 * Saved projects. `open` replaces the open project (the tab shows it); the open project's
 * unsaved changes are saved first when it is a saved one.
 */
export interface ProjectsPort {
  list(): Maybe<readonly ProjectInfo[]>;
  /** The id the open project is saved under, or null for one never saved. */
  openId(): string | null;
  open(id: string): Maybe<void>;
  /** Makes a new saved project with the starter palette and opens it. */
  create(name: string): Maybe<ProjectInfo>;
  /** Saves the open project (as a new saved project if it never was). */
  save(): Maybe<ProjectInfo>;
  remove(id: string): Maybe<void>;
}

type Maybe<T> = T | Promise<T>;

/** The clipboard as tools use it: copy puts a piece there, paste reads it. */
export interface ClipboardPort {
  get(): Maybe<Piece | null>;
  /** `from` says where it came from ("agent", a prefab name). */
  set(piece: Piece, from: string): Maybe<void>;
}

/** A shared palette as stored: the palette itself and when it last changed. */
export type StoredSharedPalette = SharedPalette & { readonly updated?: number };

/** What a prefab list shows (the session package's PrefabEntry, structurally). */
export interface PrefabInfo {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly notes?: string | undefined;
  /** Cells it holds (air left out) and the box they fill. */
  readonly cells: number;
  readonly size: readonly [number, number, number];
  /** The content hash of its piece. */
  readonly hash: string;
  readonly savedAt: number;
}

/** Prefabs as tools use them. A prefab is a piece with a name, tags and a note. */
export interface PrefabsPort {
  /** Every prefab, most recently saved first. */
  list(): Maybe<readonly PrefabInfo[]>;
  load(id: string): Maybe<Piece | null>;
  save(
    piece: Piece,
    meta: { name: string; tags?: readonly string[]; notes?: string },
  ): Maybe<PrefabInfo>;
  update(
    id: string,
    changes: {
      name?: string;
      tags?: readonly string[];
      notes?: string;
      anchor?: readonly [number, number, number];
    },
  ): Maybe<PrefabInfo>;
  delete(id: string): Maybe<void>;
}

export interface SharedPalettesPort {
  list(): Maybe<readonly StoredSharedPalette[]>;
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
  /** The numeric figures summed over the commands (a call with several copies of an edit). */
  readonly totals: Readonly<Record<string, number>>;
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

/**
 * An image a tool result carries: the envelope field `images`. Adapters turn each into the
 * transport's image content (MCP: {type: "image", data, mimeType}) and leave only a small
 * description of it in the text, so base64 never sits in the JSON an agent reads.
 */
export interface ToolImage {
  readonly mimeType: "image/png" | "image/jpeg";
  /** Base64, no data: prefix. */
  readonly data: string;
  readonly label?: string;
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
