// The region language tools share: core's Region (web-core.md, section 5) with names where core
// wants ids. A semantic means the cells holding it, as a block or as a part.

import type { Project, Region, SemanticArg } from "@voxyl/core";
import { z } from "zod";
import { resolvePalette, resolveSemantic, SemRef } from "./names.ts";

const Coord = z.number().int();
/** A position: [x, y, z], integer cells. +Y is up, north is -Z, east is +X. */
export const PosSchema = z.tuple([Coord, Coord, Coord]).describe("[x, y, z] integer cell position");
export type Pos = z.output<typeof PosSchema>;

type Ref = SemRef;
export type ToolRegion =
  | { box: [number, number, number, number, number, number] }
  | { selection: true }
  | { palette: string; descendants?: boolean | undefined; within?: ToolRegion | undefined }
  | { semantic: Ref; within?: ToolRegion | undefined }
  | {
      structure: {
        seed: [number, number, number];
        semantics?: Ref[] | undefined;
        diagonal?: boolean | undefined;
      };
      within?: ToolRegion | undefined;
    }
  | { all: ToolRegion[] }
  | { any: ToolRegion[] }
  | { not: ToolRegion }
  | { grow: number; of: ToolRegion; corners?: boolean | undefined }
  | { shrink: number; of: ToolRegion };

const Steps = z.number().int().min(1).max(64);

/**
 * A set of cells: {box:[x0,y0,z0,x1,y1,z1]} (corners inclusive, any order), {selection:true},
 * {semantic:"Name"} (cells holding it), {palette:"Name"} (cells of any of its semantics),
 * {structure:{seed:[x,y,z]}} (connected cells from a seed), {all:[...]} (intersection; {not}
 * entries subtract), {any:[...]} (union), {grow:n,of}, {shrink:n,of}. {semantic}, {palette}
 * and {structure} take an optional `within` region to search inside.
 */
export const ToolRegion: z.ZodType<ToolRegion> = z.lazy(() =>
  z.union([
    z.strictObject({ box: z.tuple([Coord, Coord, Coord, Coord, Coord, Coord]) }),
    z.strictObject({ selection: z.literal(true) }),
    z.strictObject({
      palette: z.string().trim().min(1),
      descendants: z.boolean().optional(),
      within: ToolRegion.optional(),
    }),
    z.strictObject({ semantic: SemRef, within: ToolRegion.optional() }),
    z.strictObject({
      structure: z.strictObject({
        seed: PosSchema,
        semantics: z.array(SemRef).min(1).optional(),
        diagonal: z.boolean().optional(),
      }),
      within: ToolRegion.optional(),
    }),
    z.strictObject({ all: z.array(ToolRegion).min(1) }),
    z.strictObject({ any: z.array(ToolRegion) }),
    z.strictObject({ not: ToolRegion }),
    z.strictObject({ grow: Steps, of: ToolRegion, corners: z.boolean().optional() }),
    z.strictObject({ shrink: Steps, of: ToolRegion }),
  ]),
);

/** Matches nothing (core's `any` of no regions). */
const NOTHING: Region = { any: [] };

/** Names to ids. Reading never creates anything: a semantic not derived yet matches no cells. */
export function resolveRegion(project: Project, r: ToolRegion): Region {
  if ("box" in r) return { box: r.box };
  if ("selection" in r) return { selection: true };
  const within = (x: ToolRegion | undefined) =>
    x === undefined ? {} : { within: resolveRegion(project, x) };
  if ("palette" in r) {
    return {
      palette: resolvePalette(project, r.palette),
      ...(r.descendants !== undefined && { descendants: r.descendants }),
      ...within(r.within),
    };
  }
  if ("semantic" in r) {
    const target = resolveSemantic(project, r.semantic);
    if (!target.exists) return NOTHING;
    return { semantic: target.arg, ...within(r.within) };
  }
  if ("structure" in r) {
    const { seed, semantics, diagonal } = r.structure;
    let ids: SemanticArg[] | undefined;
    if (semantics) {
      const targets = semantics.map((s) => resolveSemantic(project, s)).filter((t) => t.exists);
      if (targets.length === 0) return NOTHING;
      ids = targets.map((t) => t.arg);
    }
    return {
      structure: {
        seed,
        ...(ids !== undefined && { semantics: ids }),
        ...(diagonal !== undefined && { diagonal }),
      },
      ...within(r.within),
    };
  }
  if ("all" in r) return { all: r.all.map((x) => resolveRegion(project, x)) };
  if ("any" in r) return { any: r.any.map((x) => resolveRegion(project, x)) };
  if ("not" in r) return { not: resolveRegion(project, r.not) };
  if ("grow" in r) {
    return {
      grow: r.grow,
      of: resolveRegion(project, r.of),
      ...(r.corners !== undefined && { corners: r.corners }),
    };
  }
  return { shrink: r.shrink, of: resolveRegion(project, r.of) };
}
