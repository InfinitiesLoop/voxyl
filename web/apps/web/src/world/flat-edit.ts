// Editing in the 2D view, as core commands: a stroke of cells (pencil, line or rectangle) is
// one `set` command, a fill floods the layer within the view's window, and a cell's facing
// is reported so the view can draw it. Pure functions over a Project; they test in Node.

import {
  type CellState,
  type Command,
  EMPTY_ID,
  facingOf,
  type Project,
  type SemanticArg,
  SIDES,
  sideOf,
  upOf,
} from "@voxyl/core";
import { type BlockMaterials, lookColor } from "@voxyl/session";
import { archTriangles, isExclusive, microBoxes } from "@voxyl/shapes";
import { planeToWorld, type SliceAxis } from "../views/plane.ts";
import { commandId, EDITOR_SOURCE, semanticIdOf } from "./editing.ts";
import type { PartDraw, Vec3 } from "./protocol.ts";

/**
 * What each cell state with parts is made of, for the 2D view to draw as footprints: per part,
 * its colour and its boxes (microblocks) or triangles (roofs). States of whole blocks are left
 * out.
 */
export function statePartDraws(
  project: Project,
  blocks?: BlockMaterials,
): { state: number; parts: PartDraw[] }[] {
  const states = project.world.states;
  const colors = new Map<number, number>();
  const colorOf = (semantic: number): number => {
    let color = colors.get(semantic);
    if (color === undefined) {
      color = project.semantics.has(semantic)
        ? Number.parseInt(lookColor(project.semantics.resolve(semantic).look, blocks).slice(1), 16)
        : 0x808080;
      colors.set(semantic, color);
    }
    return color;
  };
  const out: { state: number; parts: PartDraw[] }[] = [];
  for (let id = 1; id <= states.size; id++) {
    const state = states.get(id);
    if (!state || state.parts.length === 0) continue;
    out.push({
      state: id,
      parts: state.parts.map((part) => ({
        color: colorOf(part.semantic),
        boxes: isExclusive(part.shape) ? [] : microBoxes(part.shape, part.slot).flat(),
        tris: isExclusive(part.shape) ? archTriangles(part.shape, part.slot) : [],
      })),
    });
  }
  return out;
}

/** Most cells one stroke or fill may change. */
export const MAX_FLAT_CELLS = 65536;

/**
 * The command a 2D stroke runs: `semantic` into every cell of `cells` (x, y, z triples), or
 * empties them when it is null. Turned as a click on `face` while looking `look` picks, so
 * stairs drawn by dragging right face right. Null when nothing would change.
 */
export function strokeCommand(
  project: Project,
  cells: readonly number[],
  semantic: SemanticArg | null,
  face: Vec3,
  look: Vec3,
  label: string,
): Command | null {
  if (cells.length === 0 || cells.length % 3 !== 0 || cells.length / 3 > MAX_FLAT_CELLS)
    return null;
  let state: { semantic: SemanticArg; rotation: number } | null = null;
  if (semantic !== null) {
    const id = semanticIdOf(project, semantic);
    if (!project.semantics.has(id)) return null;
    const rotation = project.placement(id).pick({ face, look, hitY: 1 });
    state = { semantic, rotation };
  }
  const flat: number[] = [];
  const world = project.world;
  for (let i = 0; i < cells.length; i += 3) {
    const x = cells[i] ?? 0;
    const y = cells[i + 1] ?? 0;
    const z = cells[i + 2] ?? 0;
    // Erasing an empty cell changes nothing; drawing keeps what is already there.
    if (state === null ? world.getId(x, y, z) === EMPTY_ID : world.getId(x, y, z) !== EMPTY_ID)
      continue;
    flat.push(x, y, z, 0);
  }
  if (flat.length === 0) return null;
  return {
    id: commandId(),
    kind: "set",
    source: EDITOR_SOURCE,
    label,
    args: { states: [state], cells: flat },
  };
}

/** A window of plane cells, [u0, v0, u1, v1) (see views/plane.ts). */
export type PlaneWindow = readonly [number, number, number, number];

/**
 * The cells a fill from plane cell (u, v) reaches: those side by side with it on the layer,
 * inside `window`, holding the same whole-block semantic (or all empty, for a fill of
 * empty space). As world x, y, z triples.
 */
export function fillCells(
  project: Project,
  axis: SliceAxis,
  depth: number,
  u: number,
  v: number,
  window: PlaneWindow,
): number[] {
  const world = project.world;
  const kindAt = (pu: number, pv: number): number => {
    const [x, y, z] = planeToWorld(axis, depth, pu, pv);
    const id = world.getId(x, y, z);
    if (id === EMPTY_ID) return 0;
    const state = world.states.get(id);
    return state && state.parts.length === 0 ? state.semantic : -1;
  };
  const [u0, v0, u1, v1] = window;
  const inside = (pu: number, pv: number) => pu >= u0 && pv >= v0 && pu < u1 && pv < v1;
  if (!inside(u, v)) return [];
  const kind = kindAt(u, v);
  if (kind < 0) return [];
  const seen = new Set<string>([`${u},${v}`]);
  const queue: [number, number][] = [[u, v]];
  const out: number[] = [];
  for (let head = 0; head < queue.length && out.length / 3 < MAX_FLAT_CELLS; head++) {
    const [cu, cv] = queue[head] as [number, number];
    out.push(...planeToWorld(axis, depth, cu, cv));
    for (const [du, dv] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nu = cu + du;
      const nv = cv + dv;
      const key = `${nu},${nv}`;
      if (seen.has(key) || !inside(nu, nv) || kindAt(nu, nv) !== kind) continue;
      seen.add(key);
      queue.push([nu, nv]);
    }
  }
  return out;
}

/** Bits of a state's facing byte: the side its front faces (1-6), and two flags. */
export const FACING_UPSIDE_DOWN = 8;
export const FACING_PARTS = 16;

/**
 * One byte per state id for the 2D view: 0 for a block that doesn't turn; otherwise the side
 * its front faces (SIDES index + 1), with FACING_UPSIDE_DOWN when its top points down
 * (stairs hung from a ceiling). A cell of parts is FACING_PARTS.
 */
export function stateFacings(project: Project): Uint8Array {
  const states = project.world.states;
  const out = new Uint8Array(states.size + 1);
  for (let id = 1; id <= states.size; id++) {
    const state: CellState | undefined = states.get(id) ?? undefined;
    if (!state) continue;
    if (state.parts.length > 0) {
      out[id] = FACING_PARTS;
      continue;
    }
    if (!project.semantics.has(state.semantic)) continue;
    if (project.placement(state.semantic).allowed.length <= 1) continue;
    const side = SIDES.indexOf(sideOf(facingOf(state.rotation)));
    const down = upOf(state.rotation)[1] < 0 ? FACING_UPSIDE_DOWN : 0;
    out[id] = (side + 1) | down;
  }
  return out;
}
