// Names to ids and back. Tools speak in semantic and palette names; core wants numeric ids. A
// name that doesn't resolve is a clear error listing the nearest matches.

import {
  type CellState,
  facingOf,
  IDENTITY,
  type PaletteId,
  type Project,
  rotationOf,
  type SemanticArg,
  type SemanticId,
  type Side,
  sideOf,
  upOf,
} from "@voxyl/core";
import { slotName } from "@voxyl/shapes";
import { z } from "zod";
import { ToolError } from "./tool.ts";

const Name = z.string().trim().min(1);

/** A semantic by name; give the palette when two palettes have a semantic of that name. */
export const SemRef = z
  .union([Name, z.strictObject({ name: Name, palette: Name.optional() })])
  .describe("A semantic name, or {name, palette} when several palettes use the same name.");
export type SemRef = z.output<typeof SemRef>;

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** The candidates nearest to a query: substring matches first, then by edit distance. */
export function nearMatches(query: string, candidates: readonly string[], limit = 5): string[] {
  const q = query.trim().toLowerCase();
  const scored = [...new Set(candidates)].map((c) => {
    const lower = c.toLowerCase();
    const contained = q.length > 0 && (lower.includes(q) || q.includes(lower));
    return { c, score: contained ? 0 : 1 + distance(q, lower) };
  });
  scored.sort((a, b) => a.score - b.score || (a.c < b.c ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.c);
}

/** The not_found failure: what was asked for, and the nearest names that exist. */
export function notFound(
  kind: string,
  query: string,
  candidates: readonly string[],
  extra: Record<string, unknown> = {},
): ToolError {
  const suggestions = nearMatches(query, candidates);
  const hint =
    suggestions.length > 0
      ? ` Did you mean ${suggestions.map((s) => `"${s}"`).join(", ")}?`
      : ` There are no ${kind}s yet.`;
  return new ToolError("not_found", `No ${kind} named "${query}".${hint}`, {
    kind,
    query,
    suggestions,
    ...extra,
  });
}

/** An exact match, else the only case-insensitive one. */
function pick<T>(items: readonly T[], name: (item: T) => string, wanted: string): T | undefined {
  const w = wanted.trim();
  const exact = items.find((i) => name(i) === w);
  if (exact !== undefined) return exact;
  const loose = items.filter((i) => name(i).toLowerCase() === w.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

export function resolvePalette(project: Project, name: string): PaletteId {
  const palettes = project.semantics.palettes();
  const found = pick(palettes, (p) => p.name, name);
  if (!found) {
    throw notFound(
      "palette",
      name,
      palettes.map((p) => p.name),
    );
  }
  return found.id;
}

/** A semantic as a target: the command argument, plus what a tool needs to know about it. */
export interface SemanticTarget {
  /** The id, or {palette, base} for a semantic the palette derives on first use. */
  readonly arg: SemanticArg;
  /** The semantic whose form applies (the base, for one not derived yet). */
  readonly formId: SemanticId;
  readonly name: string;
  /** The part shape it places by default; undefined for a whole block. */
  readonly shape: string | undefined;
  /** Whether it exists in the project already (false: using it would derive it). */
  readonly exists: boolean;
}

/** Resolves a name to a semantic a command can use (deriving it on first use if it must). */
export function resolveSemantic(project: Project, ref: SemRef): SemanticTarget {
  const registry = project.semantics;
  const { name, palette } = typeof ref === "string" ? { name: ref, palette: undefined } : ref;
  if (palette !== undefined) {
    const paletteId = resolvePalette(project, palette);
    const offers = registry.offers(paletteId);
    const offer = pick(offers, (o) => o.name, name);
    if (!offer) {
      throw notFound(
        "semantic",
        name,
        offers.map((o) => o.name),
        { palette: registry.palette(paletteId).name },
      );
    }
    const formId = (offer.id ?? offer.base) as SemanticId;
    const arg: SemanticArg =
      offer.id !== undefined ? offer.id : { palette: paletteId, base: offer.base as SemanticId };
    return {
      arg,
      formId,
      name: offer.name,
      shape: registry.resolve(formId).form.shape,
      exists: offer.id !== undefined,
    };
  }
  const all = [...registry].map((s) => s.id);
  const nameOf = (id: SemanticId) => registry.nameOf(id);
  const w = name.trim();
  let matches = all.filter((id) => nameOf(id) === w);
  if (matches.length === 0)
    matches = all.filter((id) => nameOf(id).toLowerCase() === w.toLowerCase());
  if (matches.length === 0) {
    throw notFound("semantic", name, all.map(nameOf));
  }
  if (matches.length > 1) {
    const palettes = matches.map((id) => registry.palette(registry.get(id).palette).name);
    throw new ToolError(
      "ambiguous",
      `"${name}" exists in several palettes (${palettes.join(", ")}). Give {name, palette}.`,
      { kind: "semantic", query: name, palettes },
    );
  }
  const id = matches[0] as SemanticId;
  return {
    arg: id,
    formId: id,
    name: nameOf(id),
    shape: registry.resolve(id).form.shape,
    exists: true,
  };
}

/** The sides facing and up name, as a rotation (checked to be at right angles). */
export function rotationFor(facing: Side | undefined, up: Side | undefined): number {
  if (facing !== undefined && up !== undefined) {
    const axis = (s: Side) =>
      s === "up" || s === "down" ? "y" : s === "north" || s === "south" ? "z" : "x";
    if (axis(facing) === axis(up)) {
      throw new ToolError(
        "bad_argument",
        `facing ${facing} and up ${up} must be at right angles.`,
        { facing, up },
      );
    }
  }
  return rotationOf(facing, up);
}

/** Cell contents by name, for results. */
export class Names {
  readonly #project: Project;
  readonly #counts = new Map<string, number>();

  constructor(project: Project) {
    this.#project = project;
    for (const s of project.semantics) {
      const name = project.semantics.nameOf(s.id);
      this.#counts.set(name, (this.#counts.get(name) ?? 0) + 1);
    }
  }

  name(id: SemanticId): string {
    return this.#project.semantics.nameOf(id);
  }

  /** {semantic} or {semantic, palette}, the palette only when the name alone is ambiguous. */
  ref(id: SemanticId): { semantic: string; palette?: string } {
    const r = this.#project.semantics;
    const name = r.nameOf(id);
    return (this.#counts.get(name) ?? 0) > 1
      ? { semantic: name, palette: r.palette(r.get(id).palette).name }
      : { semantic: name };
  }

  /** A cell's contents: a whole block (with facing and up when turned) or its parts. */
  describe(state: CellState): Record<string, unknown> {
    if (state.parts.length > 0) {
      return {
        parts: state.parts.map((p) => ({
          ...this.ref(p.semantic),
          shape: p.shape,
          slot: slotName(p.shape, p.slot),
        })),
      };
    }
    const out: Record<string, unknown> = { ...this.ref(state.semantic) };
    if (state.rotation !== IDENTITY) {
      const facing = sideOf(facingOf(state.rotation));
      out.facing = facing;
      if (rotationOf(facing) !== state.rotation) out.up = sideOf(upOf(state.rotation));
    }
    if (Object.keys(state.tags).length > 0) out.tags = state.tags;
    return out;
  }
}
