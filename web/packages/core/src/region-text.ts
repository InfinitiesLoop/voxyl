// A region as text, both ways (web-core.md, section 9): the cheapest way for a model, or a person
// in a text editor, to read and write structure. Ported from the Godot app's RegionCodec.gd.
// Intent only: characters stand for semantics and parts, never materials.
//
//   { origin: [x, y, z], axis: "y", legend: { char: value }, layers: [[row, ...], ...] }
//
// axis "y" (plan view): layers go up from origin.y; each layer's rows run north to south (+Z)
//   from origin.z; each row's characters run west to east (+X) from origin.x.
// axis "z" (elevation seen from the south): layers go north to south from origin.z; rows run
//   top to bottom from origin.y (the top row's y); characters run west to east.
// axis "x" (elevation seen from the east): layers go west to east from origin.x; rows run top
//   to bottom from origin.y; characters run north to south.
//
// Legend values: "Deck" (a whole block of a semantic), { semantic, palette?, facing?, up?,
// rotation?, tags? } (a block with a palette to tell same-named semantics apart, or turned), or
// [{ semantic, palette?, shape?, slot }, ...] (a cell of parts; slots by name, see slotName,
// and a part's shape left out when it is what its semantic places anyway).
// "." and " " leave a cell as it is, "_" clears it. Text written from a build uses "." for air.

import { slotFromName, slotName } from "@voxyl/shapes";
import { z } from "zod";
import { boxVolume } from "./box.ts";
import { type CellState, EMPTY_ID } from "./cell-state.ts";
import type { CellStateArg, SemanticArg } from "./commands/command.ts";
import { rotationOf, SIDE_VECTORS, type Side, SideArg, sideOf } from "./placement-profile.ts";
import type { Project } from "./project.ts";
import type { Region } from "./region.ts";
import { facingOf, IDENTITY, upOf } from "./rotation.ts";
import type { SemanticId } from "./semantics.ts";

export type TextAxis = "x" | "y" | "z";

/** Text larger than this many cells is refused: no model reads a million characters. */
export const MAX_TEXT_CELLS = 262_144;

const NameRef = z.string().trim().min(1);
const TagValue = z.union([z.string(), z.number(), z.boolean()]);

export const LegendPart = z.strictObject({
  semantic: NameRef,
  palette: NameRef.optional(),
  shape: z.string().min(1).optional(),
  slot: z.union([z.string(), z.number().int()]),
});

export const LegendValue = z.union([
  NameRef,
  z.strictObject({
    semantic: NameRef,
    palette: NameRef.optional(),
    facing: SideArg.optional(),
    up: SideArg.optional(),
    rotation: z.number().int().min(0).max(23).optional(),
    tags: z.record(z.string(), TagValue).optional(),
  }),
  z.array(LegendPart).min(1),
]);
export type LegendValue = z.output<typeof LegendValue>;

export const RegionTextArg = z.strictObject({
  origin: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  axis: z.enum(["x", "y", "z"]).optional(),
  legend: z.record(z.string().length(1), LegendValue),
  layers: z.array(z.union([z.string(), z.array(z.string())])),
});

export interface RegionText {
  readonly origin: [number, number, number];
  readonly axis: TextAxis;
  readonly legend: Record<string, LegendValue>;
  readonly layers: string[][];
}

/** The world position of a character: layer, row and column along an axis from an origin. */
export function textToWorld(
  axis: TextAxis,
  origin: readonly [number, number, number],
  layer: number,
  row: number,
  col: number,
): [number, number, number] {
  const [x, y, z] = origin;
  if (axis === "z") return [x + col, y - row, z + layer];
  if (axis === "x") return [x + layer, y - row, z + col];
  return [x + col, y + layer, z + row];
}

/** A thrown error listing everything wrong with a text (not a bug). */
export class RegionTextError extends Error {
  override readonly name = "RegionTextError";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.slice(0, 20).join("; ") + (problems.length > 20 ? "; ..." : ""));
    this.problems = problems;
  }
}

const PLAIN_POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*+=?!<>^~";
const PART_POOL = "abcdefghijklmnopqrstuvwxyz0123456789;:'\"|/\\`,-";

/**
 * The text of a region's bounds along an axis. Cells of the bounds outside the region, and
 * empty cells, show as ".".
 */
export function regionText(project: Project, where: Region, axis: TextAxis = "y"): RegionText {
  const cells = project.cells(where);
  const b = cells.bounds();
  if (!b) return { origin: [0, 0, 0], axis, legend: {}, layers: [] };
  if (boxVolume(b) > MAX_TEXT_CELLS) {
    throw new RegionTextError([
      `The region spans ${boxVolume(b)} cells; text is limited to ${MAX_TEXT_CELLS}`,
    ]);
  }
  const origin: [number, number, number] = axis === "y" ? [b.x0, b.y0, b.z0] : [b.x0, b.y1, b.z0];
  const [layers, rows, cols] =
    axis === "y"
      ? [b.y1 - b.y0 + 1, b.z1 - b.z0 + 1, b.x1 - b.x0 + 1]
      : axis === "z"
        ? [b.z1 - b.z0 + 1, b.y1 - b.y0 + 1, b.x1 - b.x0 + 1]
        : [b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1];
  const names = new Namer(project);
  const legend: Record<string, LegendValue> = {};
  const charOf = new Map<number, string>();
  const used = new Set([".", "_", " "]);
  const out: string[][] = [];
  for (let l = 0; l < layers; l++) {
    const layer: string[] = [];
    for (let r = 0; r < rows; r++) {
      let row = "";
      for (let c = 0; c < cols; c++) {
        const [x, y, z] = textToWorld(axis, origin, l, r, c);
        const id = cells.has(x, y, z) ? project.world.getId(x, y, z) : EMPTY_ID;
        const state = id === EMPTY_ID ? null : project.world.states.get(id);
        if (!state) {
          row += ".";
          continue;
        }
        let ch = charOf.get(id);
        if (ch === undefined) {
          ch = pickChar(state, names, used);
          used.add(ch);
          charOf.set(id, ch);
          legend[ch] = names.legendValue(state);
        }
        row += ch;
      }
      layer.push(row);
    }
    out.push(layer);
  }
  return { origin, axis, legend, layers: out };
}

/**
 * The `set` command arguments a text means: each legend value's state once, and the cells as
 * [x, y, z, stateIndex] quadruples ("_" is the null state, which clears). Names resolve
 * against the project; a name a palette can derive but hasn't yet becomes { palette, base }.
 * Throws RegionTextError listing every problem.
 */
export function parseRegionText(
  project: Project,
  text: z.input<typeof RegionTextArg>,
): { states: (CellStateArg | null)[]; cells: number[] } {
  const parsed = RegionTextArg.safeParse(text);
  if (!parsed.success) throw new RegionTextError([parsed.error.message]);
  const { origin, legend, layers } = parsed.data;
  const axis = parsed.data.axis ?? "y";
  const problems: string[] = [];
  const names = new Namer(project);
  const states: (CellStateArg | null)[] = [];
  const indexOf = new Map<string, number>();
  const stateFor = (ch: string): number | undefined => {
    const known = indexOf.get(ch);
    if (known !== undefined) return known;
    let state: CellStateArg | null | undefined;
    if (ch === "_") state = null;
    else {
      const value = legend[ch];
      if (value === undefined) return undefined;
      try {
        state = names.stateOf(value);
      } catch (error) {
        problems.push(`'${ch}': ${error instanceof Error ? error.message : String(error)}`);
        state = undefined;
      }
    }
    const index = state === undefined ? -1 : states.push(state) - 1;
    indexOf.set(ch, index);
    return index;
  };
  const cells: number[] = [];
  let total = 0;
  layers.forEach((rowsOrRow, l) => {
    const rows = typeof rowsOrRow === "string" ? [rowsOrRow] : rowsOrRow;
    rows.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch === "." || ch === " ") return;
        if (++total > MAX_TEXT_CELLS) return;
        const index = stateFor(ch);
        if (index === undefined) {
          problems.push(`layer ${l} row ${r} col ${c}: '${ch}' isn't in the legend`);
          return;
        }
        if (index < 0) return;
        cells.push(...textToWorld(axis, origin, l, r, c), index);
      });
    });
  });
  if (total > MAX_TEXT_CELLS) problems.push(`More than ${MAX_TEXT_CELLS} cells to set`);
  if (problems.length > 0) throw new RegionTextError(problems);
  return { states, cells };
}

/** Semantic names both ways, telling apart same-named semantics of different palettes. */
class Namer {
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

  /** The palette's name, when the semantic's name alone is ambiguous. */
  palette(id: SemanticId): string | undefined {
    const r = this.#project.semantics;
    return (this.#counts.get(r.nameOf(id)) ?? 0) > 1
      ? r.palette(r.get(id).palette).name
      : undefined;
  }

  legendValue(state: CellState): LegendValue {
    const r = this.#project.semantics;
    if (state.parts.length > 0) {
      return state.parts.map((p) => {
        const palette = this.palette(p.semantic);
        const own = r.has(p.semantic) ? r.resolve(p.semantic).form.shape : undefined;
        return {
          semantic: this.name(p.semantic),
          ...(palette !== undefined && { palette }),
          ...(own !== p.shape && { shape: p.shape }),
          slot: slotName(p.shape, p.slot),
        };
      });
    }
    const palette = this.palette(state.semantic);
    const tags = Object.keys(state.tags).length > 0 ? { ...state.tags } : undefined;
    let turned: { facing: Side; up?: Side } | undefined;
    if (state.rotation !== IDENTITY) {
      const facing = sideOf(facingOf(state.rotation));
      const up = sideOf(upOf(state.rotation));
      turned = rotationOf(facing) === state.rotation ? { facing } : { facing, up };
    }
    if (palette === undefined && tags === undefined && turned === undefined) {
      return this.name(state.semantic);
    }
    return {
      semantic: this.name(state.semantic),
      ...(palette !== undefined && { palette }),
      ...turned,
      ...(tags !== undefined && { tags }),
    };
  }

  /** The semantic a name (and palette name) refers to, as a command argument. */
  resolve(name: string, paletteName?: string): SemanticArg {
    const r = this.#project.semantics;
    if (paletteName !== undefined) {
      const palette = r.paletteByName(paletteName);
      if (!palette) throw new Error(`no palette named "${paletteName}"`);
      const offer = r.offers(palette.id).find((o) => o.name === name);
      if (!offer) throw new Error(`${paletteName} has no semantic named "${name}"`);
      return offer.id ?? { palette: palette.id, base: offer.base as SemanticId };
    }
    const matches = [...r].filter((s) => r.nameOf(s.id) === name);
    if (matches.length === 0) throw new Error(`no semantic named "${name}"`);
    if (matches.length > 1) {
      const palettes = matches.map((s) => r.palette(s.palette).name).join(", ");
      throw new Error(`"${name}" is in several palettes (${palettes}); give a palette`);
    }
    return (matches[0] as { id: SemanticId }).id;
  }

  stateOf(value: LegendValue): CellStateArg {
    const r = this.#project.semantics;
    if (typeof value === "string") return { semantic: this.resolve(value) };
    if (Array.isArray(value)) {
      return {
        parts: value.map((p) => {
          const semantic = this.resolve(p.semantic, p.palette);
          const id = typeof semantic === "number" ? semantic : semantic.base;
          const shape = p.shape ?? r.resolve(id).form.shape;
          if (shape === undefined) {
            throw new Error(`${p.semantic} places no shape of its own; give the part a shape`);
          }
          const slot = slotFromName(shape, p.slot);
          if (slot < 0) throw new Error(`${shape} has no slot "${p.slot}"`);
          return { semantic, shape, slot };
        }),
      };
    }
    if (value.rotation !== undefined && (value.facing !== undefined || value.up !== undefined)) {
      throw new Error("give a rotation or facing and up, not both");
    }
    if (value.facing !== undefined && value.up !== undefined) {
      const f = SIDE_VECTORS[value.facing];
      const u = SIDE_VECTORS[value.up];
      if (f[0] * u[0] + f[1] * u[1] + f[2] * u[2] !== 0) {
        throw new Error(`facing ${value.facing} and up ${value.up} aren't at right angles`);
      }
    }
    const rotation = value.rotation ?? rotationOf(value.facing, value.up);
    return {
      semantic: this.resolve(value.semantic, value.palette),
      ...(rotation !== IDENTITY && { rotation }),
      ...(value.tags !== undefined && { tags: value.tags }),
    };
  }
}

/** Whole blocks get capitals (the semantic's own letters first), cells of parts lower case. */
function pickChar(state: CellState, names: Namer, used: Set<string>): string {
  const shaped = state.parts.length > 0;
  const pool = shaped ? PART_POOL : PLAIN_POOL;
  const name = names.name(shaped ? (state.parts[0]?.semantic ?? 0) : state.semantic);
  const own = shaped ? name.toLowerCase() : name.toUpperCase();
  for (const ch of own + pool) if (pool.includes(ch) && !used.has(ch)) return ch;
  // Past the pools: letters from further along Unicode, one character each.
  for (let code = 0x391; ; code++) {
    const ch = String.fromCodePoint(code);
    if (/\p{L}/u.test(ch) && !used.has(ch)) return ch;
  }
}
