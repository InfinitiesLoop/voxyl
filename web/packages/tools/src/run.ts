// Running a tool's commands as one call: ids, labels, the undo group, dry runs on a fork, and
// one summary over however many commands ran.

import {
  type Box,
  type ChangeReport,
  type Command,
  type Project,
  type SemanticChange,
  unionBox,
} from "@voxyl/core";
import type { RunSummary, ToolCall, ToolHost } from "./tool.ts";

let counter = 0;

/** A fresh id for a call that named none. */
export function generateId(host: ToolHost): string {
  if (host.newId) return host.newId();
  const crypto = (globalThis as unknown as { crypto?: { randomUUID?(): string } }).crypto;
  return crypto?.randomUUID?.() ?? `op-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export function makeCall(
  host: ToolHost,
  project: Project,
  tool: string,
  opId: string,
  dryRun: boolean,
): ToolCall {
  const group = `claude:${opId}`;
  const label = `Claude: ${tool}`;
  return {
    tool,
    project,
    opId,
    dryRun,
    async run(specs, suffix) {
      const commandId = (i: number) =>
        suffix !== undefined ? `${opId}:${suffix}` : specs.length === 1 ? opId : `${opId}:${i + 1}`;
      const commands: Command[] = specs.map((s, i) => ({
        id: commandId(i),
        kind: s.kind,
        args: s.args,
        source: "Claude",
        label,
        group,
      }));
      if (dryRun) return applyAll(project.fork(), commands, true);
      // Several commands: prove the whole sequence on a fork first, so a bad later command
      // can't leave the earlier ones applied.
      if (commands.length > 1) applyAll(project.fork(), commands, true);
      const summary = applyAll(project, commands, false);
      if (!summary.duplicate) {
        await host.changed?.(project, { tool, commandIds: summary.ids });
      }
      return summary;
    },
  };
}

function applyAll(target: Project, commands: readonly Command[], dryRun: boolean): RunSummary {
  const reports: ChangeReport[] = [];
  let duplicate = false;
  for (const command of commands) {
    const result = target.run(command);
    if (result.status === "duplicate") duplicate = true;
    reports.push(result.report);
  }
  return summarize(target, commands, reports, dryRun, duplicate);
}

function summarize(
  target: Project,
  commands: readonly Command[],
  reports: readonly ChangeReport[],
  dryRun: boolean,
  duplicate: boolean,
): RunSummary {
  let cells = 0;
  let bounds: Box | null = null;
  const semantics = new Map<number, SemanticChange>();
  const palettes: string[] = [];
  const created: string[] = [];
  const notes: Record<string, number | string> = {};
  for (const r of reports) {
    cells += r.cells;
    bounds = unionBox(bounds, r.bounds);
    // The commands of one call touch different cells, so the counts add up.
    for (const s of r.semantics) {
      const seen = semantics.get(s.semantic);
      semantics.set(
        s.semantic,
        seen ? { ...seen, before: seen.before + s.before, after: seen.after + s.after } : s,
      );
    }
    for (const id of r.created.palettes) {
      if (target.semantics.hasPalette(id)) palettes.push(target.semantics.palette(id).name);
    }
    for (const id of r.created.semantics) {
      if (target.semantics.has(id)) created.push(target.semantics.nameOf(id));
    }
    Object.assign(notes, r.notes);
  }
  return {
    dryRun,
    duplicate,
    ids: commands.map((c) => c.id),
    cells,
    bounds,
    semantics: [...semantics.values()],
    created: { palettes, semantics: created },
    notes,
    after: target,
  };
}
