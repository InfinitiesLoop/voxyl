import type { HistoryEntry, Project } from "@voxyl/core";
import { z } from "zod";
import { LIST_CAP, MutatingFields } from "../result.ts";
import { defineTool, type ToolResult } from "../tool.ts";

const MAX_STEPS = 50;

function labelOf(entry: HistoryEntry): string {
  const c = entry.command;
  return c.label ?? `${c.source ?? "editor"}: ${c.kind}`;
}

function entryById(project: Project, id: string | null): HistoryEntry | undefined {
  return id === null ? undefined : project.history.find((e) => e.command.id === id);
}

/** The labels of the next undo and the next redo (null when there is none). */
export function historyLabels(project: Project): {
  next_undo: string | null;
  next_redo: string | null;
} {
  const undo = entryById(project, project.undoTarget());
  const redo = entryById(project, project.redoTarget());
  return { next_undo: undo ? labelOf(undo) : null, next_redo: redo ? labelOf(redo) : null };
}

interface Step {
  label: string;
  source: string;
  commands: number;
  state: string;
  id: string;
}

/** Undo steps, oldest first: consecutive commands of one group are one step. */
function steps(project: Project): Step[] {
  const out: Step[] = [];
  let lastGroup: string | undefined;
  for (const e of project.history) {
    if (!e.undoable) continue;
    const group = e.command.group;
    const last = out.at(-1);
    if (last && group !== undefined && group === lastGroup) {
      last.commands++;
      last.id = e.command.id;
      continue;
    }
    lastGroup = group;
    out.push({
      label: labelOf(e),
      source: e.command.source ?? "editor",
      commands: 1,
      state: e.state,
      id: e.command.id,
    });
  }
  return out;
}

export const history = defineTool({
  name: "history",
  title: "History, undo and redo",
  description:
    "action list shows recent undo steps (oldest first, with the next undo and redo). " +
    "action undo or redo steps back or forward `count` times; each step is one tool call or " +
    "editor action, including the user's. Undone steps stay redoable until a new edit.",
  input: z.strictObject({
    action: z.enum(["list", "undo", "redo"]),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_STEPS)
      .optional()
      .describe("Steps to list (default 20) or to undo or redo (default 1)."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  async handler(_host, args, call) {
    const project = call.project;
    if (args.action === "list") {
      const all = steps(project);
      const shown = all.slice(-(args.count ?? LIST_CAP));
      return {
        steps: shown.map(({ id: _id, ...step }) => step),
        total_steps: all.length,
        ...historyLabels(project),
      };
    }
    const undo = args.action === "undo";
    const count = args.count ?? 1;
    const done: string[] = [];
    const problems: string[] = [];
    let duplicate = false;
    // Dry run: what would be stepped over, read off the history without touching it.
    if (call.dryRun) {
      const labels = undo ? undoable(project) : redoable(project);
      return {
        dry_run: true,
        [undo ? "would_undo" : "would_redo"]: labels.slice(0, count),
        ...historyLabels(project),
        problems: labels.length < count ? [`Only ${labels.length} step(s) to ${args.action}.`] : [],
      } satisfies ToolResult;
    }
    for (let i = 0; i < count; i++) {
      const target = undo ? project.undoTarget() : project.redoTarget();
      const entry = entryById(project, target);
      if (target === null || !entry) {
        problems.push(`Nothing more to ${args.action}.`);
        break;
      }
      const summary = await call.run([{ kind: args.action, args: { target } }], String(i + 1));
      if (summary.duplicate) {
        duplicate = true;
        break;
      }
      done.push(labelOf(entry));
    }
    return {
      ...(duplicate && {
        duplicate: true,
        note: "This op_id was already applied; nothing changed this time.",
      }),
      [undo ? "undone" : "redone"]: done,
      ...historyLabels(project),
      problems,
    };
  },
});

/** The labels undo would step over, newest first. */
function undoable(project: Project): string[] {
  return stepLabels([...project.history].reverse(), "active");
}

/** The labels redo would step over: the earliest undone step comes back first. */
function redoable(project: Project): string[] {
  return stepLabels(project.history, "undone");
}

/** One label per run of same-group entries in this state. */
function stepLabels(entries: readonly HistoryEntry[], state: HistoryEntry["state"]): string[] {
  const out: string[] = [];
  let lastGroup: string | undefined;
  for (const e of entries) {
    if (!e.undoable || e.state !== state) continue;
    const group = e.command.group;
    if (group === undefined || group !== lastGroup) out.push(labelOf(e));
    lastGroup = group;
  }
  return out;
}
