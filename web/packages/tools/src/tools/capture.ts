// Offscreen pictures of the build. The tool picks the camera; the editor's renderer takes
// the picture after the call returns (a tab effect) and adds it to the result. The user's
// own camera does not move. Whatever is not meshed yet is not in the picture.

import type { Box } from "@voxyl/core";
import { regionStats } from "@voxyl/core";
import { z } from "zod";
import { parseBearing, parseElevation } from "../camera.ts";
import { resolveRegion, ToolRegion } from "../region.ts";
import { boundsOf, OpFields } from "../result.ts";
import { type CaptureShot, defineTool, type ToolCall, ToolError } from "../tool.ts";

const MODES = ["textured", "intent", "clay", "outline", "xray", "wire"] as const;
const SHADINGS = ["app", "studio", "flat"] as const;
const BACKGROUNDS = ["sky", "plain"] as const;
const PRESETS = ["review", "elevations", "turntable", "compare"] as const;

const Bearing = z.union([z.number(), z.string().trim().min(1)]);
const Size = z.tuple([z.number().int().min(64).max(1280), z.number().int().min(64).max(1280)]);

const Render = z
  .strictObject({
    mode: z.enum(MODES).optional(),
    shading: z.enum(SHADINGS).optional(),
    background: z.enum(BACKGROUNDS).optional(),
  })
  .optional();

interface Look {
  readonly mode: (typeof MODES)[number];
  readonly shading: (typeof SHADINGS)[number];
  readonly background: (typeof BACKGROUNDS)[number];
  readonly ortho: boolean;
}

interface Angle {
  readonly label: string;
  readonly from: string;
  readonly elevation: string;
  readonly ortho: boolean;
}

const REVIEW: readonly Angle[] = [
  { label: "Hero", from: "se", elevation: "mid", ortho: false },
  { label: "Eye level", from: "se", elevation: "eye", ortho: false },
  { label: "Front", from: "south", elevation: "level", ortho: true },
  { label: "Side", from: "east", elevation: "level", ortho: true },
  { label: "Top", from: "south", elevation: "top", ortho: true },
  { label: "Back", from: "nw", elevation: "mid", ortho: false },
];

const ELEVATIONS: readonly Angle[] = ["north", "east", "south", "west"].map((from) => ({
  label: from[0]?.toUpperCase() + from.slice(1),
  from,
  elevation: "level",
  ortho: true,
}));

const TURNTABLE: readonly Angle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"].map((from) => ({
  label: from.toUpperCase(),
  from,
  elevation: "mid",
  ortho: false,
}));

function boxOf(bounds: Box): CaptureShot["box"] {
  return {
    min: [bounds.x0, bounds.y0, bounds.z0],
    max: [bounds.x1 + 1, bounds.y1 + 1, bounds.z1 + 1],
  };
}

function frameOf(
  call: ToolCall,
  where: z.output<typeof ToolRegion> | undefined,
): {
  box: CaptureShot["box"];
  bounds: ReturnType<typeof boundsOf>;
} {
  const stats = regionStats(call.project, where ? resolveRegion(call.project, where) : undefined);
  if (!stats.bounds) {
    throw new ToolError("bad_region", where ? "The region holds no cells." : "The build is empty.");
  }
  return { box: boxOf(stats.bounds), bounds: boundsOf(stats.bounds) };
}

function lookFor(angle: Angle, render: z.output<typeof Render>): Look {
  const ortho = angle.ortho;
  return {
    mode: render?.mode ?? (ortho ? "intent" : "textured"),
    shading: render?.shading ?? (ortho ? "studio" : "app"),
    background: render?.background ?? (ortho ? "plain" : "sky"),
    ortho,
  };
}

function shot(
  label: string,
  box: CaptureShot["box"],
  from: number | string,
  elevation: number | string,
  look: Look,
  fov: number,
  size: readonly [number, number],
): CaptureShot {
  return {
    label,
    box,
    bearing: parseBearing(from),
    elevation: parseElevation(elevation),
    fov,
    ortho: look.ortho,
    mode: look.mode,
    shading: look.shading,
    background: look.background,
    width: size[0],
    height: size[1],
  };
}

export const capture = defineTool({
  name: "capture",
  title: "Photograph the build",
  description:
    "Render the build offscreen from a compass side. The user's camera does not move. The " +
    "picture comes back on this result when an editor tab is attached (it shows what is " +
    "already meshed). from is n, ne, e, se, s, sw, w, nw (or degrees clockwise from north); " +
    "elevation is top, high, iso, mid, low, eye, level, or degrees. Default: from the " +
    "south-east, mid elevation, framing the whole build.",
  input: z.strictObject({
    where: ToolRegion.optional().describe("Frame this region. Omit for the whole build."),
    from: Bearing.optional().describe("Where the camera stands. Default se."),
    elevation: Bearing.optional().describe("Height of the camera. Default mid (30°)."),
    fov: z.number().min(10).max(120).optional().describe("Vertical field of view. Default 50."),
    ortho: z.boolean().optional().describe("Orthographic projection."),
    mode: z.enum(MODES).optional(),
    shading: z.enum(SHADINGS).optional(),
    background: z.enum(BACKGROUNDS).optional(),
    size: Size.optional().describe("[width, height] in pixels. Default [960, 540]."),
    ...OpFields,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler(host, args, call) {
    const frame = frameOf(call, args.where);
    const ortho = args.ortho === true;
    const taken = shot(
      "Capture",
      frame.box,
      args.from ?? "se",
      args.elevation ?? "mid",
      {
        mode: args.mode ?? (ortho ? "intent" : "textured"),
        shading: args.shading ?? (ortho ? "studio" : "app"),
        background: args.background ?? (ortho ? "plain" : "sky"),
        ortho,
      },
      args.fov ?? 50,
      args.size ?? [960, 540],
    );
    if (!args.dry_run) {
      if (!host.effect) {
        throw new ToolError(
          "unavailable",
          "Captures render in the editor tab, and this host has none.",
        );
      }
      host.effect({ kind: "capture", shots: [taken], columns: 1 });
    }
    return {
      ...(args.dry_run && { dry_run: true }),
      bounds: frame.bounds,
      from: taken.bearing,
      elevation: taken.elevation,
      ortho: taken.ortho,
      mode: taken.mode,
      size: [taken.width, taken.height],
    };
  },
});

export const captureSheet = defineTool({
  name: "capture_sheet",
  title: "Photograph several views",
  description:
    "Several labelled views in one image. preset review (hero, eye level, front, side, top, " +
    "back), elevations (four orthographic sides), turntable (eight bearings; elevation sets " +
    "their height), or compare (one camera over each of regions; from and elevation set that " +
    "camera). frame applies to every tile except compare. " +
    "Orthographic tiles default to intent colours on a plain background. The user's camera " +
    "does not move.",
  input: z.strictObject({
    preset: z.enum(PRESETS),
    frame: ToolRegion.optional().describe(
      "Frame every tile on this region. Default: the whole build.",
    ),
    regions: z.array(ToolRegion).min(1).max(8).optional().describe("compare: one region per tile."),
    labels: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
    from: Bearing.optional().describe(
      "compare and turntable: the shared side. Default se / the preset's.",
    ),
    elevation: Bearing.optional(),
    render: Render,
    tile: Size.optional().describe("[width, height] of each tile. Default [640, 360]."),
    columns: z.number().int().min(1).max(8).optional(),
    ...OpFields,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler(host, args, call) {
    const size = args.tile ?? ([640, 360] as const);
    const fov = 50;
    const shots: CaptureShot[] = [];
    if (args.preset === "compare") {
      if (!args.regions)
        throw new ToolError("bad_argument", "compare needs regions, one per tile.");
      args.regions.forEach((region, i) => {
        const frame = frameOf(call, region);
        const angle: Angle = {
          label: args.labels?.[i] ?? `Region ${i + 1}`,
          from: "se",
          elevation: "mid",
          ortho: false,
        };
        shots.push(
          shot(
            angle.label,
            frame.box,
            args.from ?? angle.from,
            args.elevation ?? angle.elevation,
            lookFor(angle, args.render),
            fov,
            size,
          ),
        );
      });
    } else {
      const frame = frameOf(call, args.frame);
      const angles =
        args.preset === "review" ? REVIEW : args.preset === "elevations" ? ELEVATIONS : TURNTABLE;
      for (const angle of angles) {
        const elevation =
          args.preset === "turntable" && args.elevation !== undefined
            ? args.elevation
            : angle.elevation;
        shots.push(
          shot(
            angle.label,
            frame.box,
            angle.from,
            elevation,
            lookFor(angle, args.render),
            fov,
            size,
          ),
        );
      }
    }
    const columns =
      args.columns ?? (args.preset === "review" ? 3 : args.preset === "turntable" ? 4 : 2);
    if (!args.dry_run) {
      if (!host.effect) {
        throw new ToolError(
          "unavailable",
          "Captures render in the editor tab, and this host has none.",
        );
      }
      host.effect({ kind: "capture", shots, columns });
    }
    return {
      ...(args.dry_run && { dry_run: true }),
      preset: args.preset,
      tiles: shots.map((s) => ({
        label: s.label,
        from: s.bearing,
        elevation: s.elevation,
        ortho: s.ortho,
      })),
      columns,
      tile: [size[0], size[1]],
    };
  },
});
