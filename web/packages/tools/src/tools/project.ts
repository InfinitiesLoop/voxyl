// The project tools: which projects exist, open or create one, its settings, save, delete.
// Opening, creating, saving and deleting are done by the tab (the editor reloads its views), so
// they ride back as effects; the settings go through core's `settings` command like any edit.

import { DirectionArg } from "@voxyl/core";
import { z } from "zod";
import { notFound } from "../names.ts";
import { editResult, OpFields } from "../result.ts";
import {
  defineTool,
  type ProjectInfo,
  type ProjectsPort,
  ToolError,
  type ToolHost,
} from "../tool.ts";

function projectsOf(host: ToolHost): ProjectsPort {
  if (!host.projects) throw new ToolError("unavailable", "This host has no saved projects.");
  return host.projects;
}

/** The saved project a name (or id) means. */
async function resolveProject(host: ToolHost, ref: string): Promise<ProjectInfo> {
  const all = await projectsOf(host).list();
  const wanted = ref.trim();
  const byId = all.find((p) => p.id === wanted);
  if (byId) return byId;
  const exact = all.filter((p) => p.name === wanted);
  const found =
    exact.length > 0 ? exact : all.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (found.length === 1) return found[0] as ProjectInfo;
  if (found.length > 1) {
    throw new ToolError(
      "ambiguous",
      `${found.length} projects are named "${wanted}". Use an id: ${found.map((p) => p.id).join(", ")}.`,
      { ids: found.map((p) => p.id) },
    );
  }
  throw notFound(
    "project",
    ref,
    all.map((p) => p.name),
  );
}

const Name = z.string().trim().min(1).max(120);

export const projectList = defineTool({
  name: "project_list",
  title: "List saved projects",
  description:
    "The user's saved projects, most recently saved first: name, cells, when saved, and which " +
    "one is open. Open one with project_open.",
  input: z.strictObject({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  async handler(host) {
    const port = projectsOf(host);
    const openId = port.openId();
    const all = await port.list();
    return {
      projects: all.map((p) => ({
        name: p.name,
        id: p.id,
        cells: p.cells,
        saved_at: new Date(p.savedAt).toISOString(),
        ...(p.id === openId && { open: true }),
      })),
      open: host.project?.settings.name ?? null,
      open_is_saved: openId !== null,
    };
  },
});

export const projectOpen = defineTool({
  name: "project_open",
  title: "Open a saved project",
  description:
    "Open a saved project by name in the user's editor, replacing the open one (a saved " +
    "open project keeps its changes; an unsaved one is lost, so project_save first). " +
    "Camera, selection and history are the new project's.",
  input: z.strictObject({ name: Name.describe("Project name (or id)."), ...OpFields }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  needsProject: false,
  async handler(host, args) {
    const port = projectsOf(host);
    const info = await resolveProject(host, args.name);
    const unsaved = host.project !== null && port.openId() === null;
    if (args.dry_run === true) {
      return { dry_run: true, would_open: info.name, would_discard_unsaved: unsaved };
    }
    await port.open(info.id);
    return {
      opened: info.name,
      ...(unsaved && {
        problems: ["The project that was open had never been saved; its changes are gone."],
      }),
    };
  },
});

export const projectCreate = defineTool({
  name: "project_create",
  title: "Create a project",
  description:
    "Create a new saved project with the starter palette and open it, replacing the open " +
    "one (an unsaved open project is lost). The name need not be unique.",
  input: z.strictObject({ name: Name, ...OpFields }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  needsProject: false,
  async handler(host, args) {
    const port = projectsOf(host);
    const unsaved = host.project !== null && port.openId() === null;
    if (args.dry_run === true) {
      return { dry_run: true, would_create: args.name, would_discard_unsaved: unsaved };
    }
    const info = await port.create(args.name);
    return {
      created: info.name,
      ...(unsaved && {
        problems: ["The project that was open had never been saved; its changes are gone."],
      }),
    };
  },
});

export const projectSave = defineTool({
  name: "project_save",
  title: "Save the open project",
  description:
    "Save the open project now. A project that was opened from storage is also saved " +
    "automatically a moment after every change; this matters for a new or sample project, " +
    "which becomes a saved one.",
  input: z.strictObject({ ...OpFields }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(host, args) {
    if (args.dry_run === true) return { dry_run: true };
    const info = await projectsOf(host).save();
    return { saved: info.name, cells: info.cells };
  },
});

export const projectDelete = defineTool({
  name: "project_delete",
  title: "Delete a saved project",
  description:
    "Permanently delete a saved project by name. Needs confirm:true. Deleting the open project " +
    "closes it in the editor.",
  input: z.strictObject({
    name: Name.describe("Project name (or id)."),
    confirm: z.boolean().optional().describe("Must be true."),
    ...OpFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  needsProject: false,
  async handler(host, args) {
    const port = projectsOf(host);
    const info = await resolveProject(host, args.name);
    if (args.confirm !== true) {
      throw new ToolError(
        "confirm_required",
        `Deleting "${info.name}" is permanent. Pass confirm:true.`,
        { project: info.name, cells: info.cells },
      );
    }
    if (args.dry_run === true) return { dry_run: true, would_delete: info.name };
    const wasOpen = info.id === port.openId();
    await port.remove(info.id);
    return { deleted: info.name, was_open: wasOpen };
  },
});

export const projectSettings = defineTool({
  name: "project_settings",
  title: "Project settings",
  description:
    "Read or change the open project's settings. `north`: which of the project's own " +
    "directions is the real north (north = -Z by default; east = +X); cells never move, but " +
    "prefabs and the clipboard are turned so north stays north when crossing projects. " +
    "`grid`: [x, z] offset (0-15) of the major grid lines. `name`, `note` (shown when opened). " +
    "Give nothing to just read them. One undo step.",
  input: z.strictObject({
    name: Name.optional(),
    north: DirectionArg.optional(),
    grid: z.tuple([z.number().int().min(0).max(15), z.number().int().min(0).max(15)]).optional(),
    note: z.string().max(4000).optional(),
    ...OpFields,
    project: z.string().min(1).optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(_host, args, call) {
    const { name, north, grid, note } = args;
    const patch = {
      ...(name !== undefined && { name }),
      ...(north !== undefined && { north }),
      ...(grid !== undefined && { grid }),
      ...(note !== undefined && { note }),
    };
    const read = (p: typeof call.project) => ({
      settings: {
        name: p.settings.name,
        north: p.settings.north,
        grid: p.settings.grid,
        note: p.settings.note,
      },
    });
    if (Object.keys(patch).length === 0) return read(call.project);
    const summary = await call.run([{ kind: "settings", args: patch }]);
    return editResult(summary, read(summary.after));
  },
});
