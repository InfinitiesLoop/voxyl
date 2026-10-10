// Tools that change what the user is looking at. They are editor state, not project data, so
// they stay out of the worker registry and run in the tab (web-tools.md). The same client
// that publishes the data tools publishes these beside them.

import {
  parseBearing,
  parseElevation,
  type ToolEnvelope,
  ToolError,
  type ToolListing,
} from "@voxyl/tools";
import { z } from "zod";
import type { ViewSettings } from "../editor/view-options.ts";

const MODES = ["textured", "intent", "clay", "outline", "xray", "wire"] as const;
const SHADINGS = ["app", "studio", "flat"] as const;
const PROJECTIONS = ["perspective", "orthographic"] as const;
const BACKGROUNDS = ["sky", "plain"] as const;
const ORBITS = ["off", "slow", "medium", "fast"] as const;
const TOOLS = ["build", "column", "wand", "exchange", "paste", "select"] as const;

const Box6 = z.tuple([
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
]);

export interface ViewSnap {
  readonly id: string;
  readonly kind: "3d" | "2d";
  readonly focused: boolean;
  readonly view?: ViewSettings;
  readonly camera?: { position: readonly [number, number, number]; yaw: number; pitch: number };
}

/** What the tab's editor can do for these tools. */
export interface UiHost {
  views(): readonly ViewSnap[];
  /** `id` is a pane id, already resolved from "focused". */
  setRender(id: string, patch: Partial<ViewSettings>): void;
  frame(
    id: string,
    box: "all" | "selection" | readonly [number, number, number, number, number, number],
    camera: { bearing: number; elevation: number; fov?: number },
  ): Promise<void>;
  cutaway(): { min: readonly number[]; max: readonly number[]; enabled: boolean } | null;
  /**
   * clear forgets it. selection hides the user's current selection. box replaces it (inclusive
   * corners). enabled switches the current box; omitted means on.
   */
  applyCutaway(action: {
    clear?: boolean;
    selection?: boolean;
    box?: { min: number[]; max: number[] };
    enabled?: boolean;
  }): { min: readonly number[]; max: readonly number[]; enabled: boolean } | null;
  hotbar(): { slots: readonly (string | null)[]; selected: number };
  setHotbar(slots: readonly (string | null)[] | undefined, selected: number | undefined): void;
  tool(): { tool: string; brush: number };
  setTool(tool: (typeof TOOLS)[number], brush: number | undefined): void;
}

interface UiTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly annotations: ToolListing["annotations"];
  run(
    host: UiHost,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

function viewId(host: UiHost, ref: string | undefined): ViewSnap {
  const views = host.views();
  const wanted = ref && ref !== "focused" ? ref : null;
  const found = wanted
    ? views.find((v) => v.id === wanted)
    : (views.find((v) => v.focused && v.kind === "3d") ?? views.find((v) => v.kind === "3d"));
  if (!found) {
    throw new ToolError(
      "no_view",
      wanted ? `No view "${wanted}". See view_list.` : "No 3D view is open.",
    );
  }
  if (found.kind !== "3d") {
    throw new ToolError("no_view", `${found.id} is a 2D view. view_set moves a 3D view.`);
  }
  return found;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function describe(view: ViewSnap): Record<string, unknown> {
  const camera = view.camera;
  return {
    id: view.id,
    kind: view.kind,
    ...(view.focused && { focused: true }),
    ...(view.view && { render: view.view }),
    ...(camera && {
      camera: {
        position: camera.position.map(round1),
        yaw_degrees: round1((camera.yaw * 180) / Math.PI),
        pitch_degrees: round1((camera.pitch * 180) / Math.PI),
      },
    }),
  };
}

const UI: readonly UiTool[] = [
  {
    name: "view_list",
    title: "List the user's views",
    description:
      "The open panes: id, whether it is 3D or 2D, which is focused, and a 3D view's camera " +
      "and render settings. Yaw 0 looks toward -Z.",
    input: z.strictObject({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run(host) {
      return { views: host.views().map(describe) };
    },
  },
  {
    name: "view_set",
    title: "Aim the user's camera",
    description:
      "Move a 3D view's camera and/or its lens (mode, shading, projection, background, orbit) " +
      'so the user sees what you built. view is "focused" (default) or an id from view_list. ' +
      'camera.frame is "all" (default), "selection", or {box:[x0,y0,z0,x1,y1,z1]}. ' +
      "from and elevation are the same words capture uses.",
    input: z.strictObject({
      view: z.string().trim().min(1).optional(),
      camera: z
        .strictObject({
          frame: z.union([z.enum(["all", "selection"]), z.strictObject({ box: Box6 })]).optional(),
          from: z.union([z.number(), z.string().trim().min(1)]).optional(),
          elevation: z.union([z.number(), z.string().trim().min(1)]).optional(),
          fov: z.number().min(10).max(120).optional(),
        })
        .optional(),
      render: z
        .strictObject({
          mode: z.enum(MODES).optional(),
          shading: z.enum(SHADINGS).optional(),
          projection: z.enum(PROJECTIONS).optional(),
          background: z.enum(BACKGROUNDS).optional(),
          orbit: z.enum(ORBITS).optional(),
        })
        .optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(host, raw) {
      const args = raw as {
        view?: string;
        camera?: {
          frame?: "all" | "selection" | { box: [number, number, number, number, number, number] };
          from?: number | string;
          elevation?: number | string;
          fov?: number;
        };
        render?: Partial<ViewSettings>;
      };
      const view = viewId(host, args.view);
      if (args.render && Object.keys(args.render).length > 0) host.setRender(view.id, args.render);
      if (args.camera) {
        const frame = args.camera.frame ?? "all";
        const box = frame === "all" || frame === "selection" ? frame : frame.box;
        await host.frame(view.id, box, {
          bearing: parseBearing(args.camera.from ?? "se"),
          elevation: parseElevation(args.camera.elevation ?? "mid"),
          ...(args.camera.fov !== undefined && { fov: args.camera.fov }),
        });
      }
      const after = host.views().find((v) => v.id === view.id);
      return { view: after ? describe(after) : { id: view.id } };
    },
  },
  {
    name: "cutaway",
    title: "Hide part of the user's view",
    description:
      "The user's cutaway: a box of cells hidden in their 3D views so they can see inside. " +
      "No arguments reads it. box is [x0,y0,z0,x1,y1,z1] inclusive, or selection:true to hide " +
      "the current selection. enabled switches it off without forgetting it. clear forgets it.",
    input: z.strictObject({
      box: Box6.optional(),
      selection: z.literal(true).optional(),
      enabled: z.boolean().optional(),
      clear: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run(host, raw) {
      const args = raw as {
        box?: [number, number, number, number, number, number];
        selection?: true;
        enabled?: boolean;
        clear?: boolean;
      };
      if (!args.box && !args.selection && args.enabled === undefined && !args.clear) {
        return { cutaway: host.cutaway() };
      }
      if (args.box && args.selection) {
        throw new ToolError("bad_argument", "Pass box or selection, not both.");
      }
      const b = args.box;
      const cutaway = host.applyCutaway({
        ...(args.clear && { clear: true }),
        ...(args.selection && { selection: true }),
        ...(b && {
          box: {
            min: [Math.min(b[0], b[3]), Math.min(b[1], b[4]), Math.min(b[2], b[5])],
            max: [Math.max(b[0], b[3]), Math.max(b[1], b[4]), Math.max(b[2], b[5])],
          },
        }),
        ...(args.enabled !== undefined && { enabled: args.enabled }),
      });
      return { cutaway };
    },
  },
  {
    name: "hotbar_set",
    title: "Fill the user's hotbar",
    description:
      "Put semantic names in the user's hotbar (nine slots) and choose one. select is 1 to 9, " +
      "the slot keys. slots replaces the bar (shorter lists clear the rest). Omit slots to " +
      "only change which slot is chosen.",
    input: z.strictObject({
      slots: z.array(z.string().trim().min(1).nullable()).max(9).optional(),
      select: z.number().int().min(1).max(9).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run(host, raw) {
      const args = raw as { slots?: (string | null)[]; select?: number };
      if (args.slots || args.select !== undefined) {
        host.setHotbar(args.slots, args.select === undefined ? undefined : args.select - 1);
      }
      const bar = host.hotbar();
      return { hotbar: { slots: bar.slots, selected: bar.selected + 1 } };
    },
  },
  {
    name: "tool_set",
    title: "Hand the user a tool",
    description:
      "The tool the user's right click runs: build (one block), column (a line toward them), " +
      "wand (grow a surface), exchange (swap in place), paste (the clipboard), select (a box). " +
      "brush is 1 to 9 and matters for column and exchange.",
    input: z.strictObject({
      tool: z.enum(TOOLS),
      brush: z.number().int().min(1).max(9).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run(host, raw) {
      const args = raw as { tool: (typeof TOOLS)[number]; brush?: number };
      host.setTool(args.tool, args.brush);
      return host.tool();
    },
  },
];

const BY_NAME = new Map(UI.map((tool) => [tool.name, tool]));

export function isUiTool(name: string): boolean {
  return BY_NAME.has(name);
}

export function listUiTools(): ToolListing[] {
  return UI.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >,
    annotations: tool.annotations,
  }));
}

export async function callUiTool(host: UiHost, name: string, raw: unknown): Promise<ToolEnvelope> {
  const tool = BY_NAME.get(name);
  if (!tool) {
    return { ok: false, error: { code: "unknown_tool", message: `No tool named "${name}".` } };
  }
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        code: "bad_argument",
        message: issue?.message ?? "Bad arguments.",
        ...(issue?.path.length && { path: issue.path.map(String).join(".") }),
      },
    };
  }
  try {
    return { ok: true, ...(await tool.run(host, parsed.data as Record<string, unknown>)) };
  } catch (error) {
    if (error instanceof ToolError) {
      return { ok: false, error: { code: error.code, message: error.message, ...error.details } };
    }
    return {
      ok: false,
      error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
