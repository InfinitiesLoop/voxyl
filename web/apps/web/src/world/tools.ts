// The building tools that place more than one block a click, after the Godot app's
// (View3D.gd): Build to me, the Wand and Exchange. Each works out its cells from where the
// crosshair aims, and that one list both previews the click and becomes its command, so the
// preview can never disagree with what is built. A click is one `set` command: one undo step,
// labelled, the same thing an agent could send. Pure functions over a Project; they run in
// the world worker and test in Node.

import { type Command, EMPTY_ID, type Project, type SemanticArg, type World } from "@voxyl/core";
import { type Aim, commandId, EDITOR_SOURCE, semanticIdOf } from "./editing.ts";
import type { Vec3 } from "./protocol.ts";

/** The tools a right click builds with; Build itself places one block (placeCommand). */
export type BuildTool = "column" | "wand" | "exchange";

/** The wand's flood reaches at most this many cells each way from the click (Godot's). */
export const WAND_LIMIT = 32;
/** Build to me lays at most this many cells toward the camera. */
export const COLUMN_LIMIT = 256;
/** The widest brush: Build to me's square, Exchange's reach. */
export const MAX_BRUSH = 9;

export interface ToolClick {
  readonly tool: BuildTool;
  readonly aim: Aim;
  /** Where the camera is: Build to me stops just short of its cell. */
  readonly camera: Vec3;
  /** 1 is a single column or block; 3 a 3×3 square or a reach of 2 about the click. */
  readonly brush: number;
}

/** A whole block's semantic in a cell, or null (empty, or a cell of parts). */
function blockSemantic(world: World, x: number, y: number, z: number): number | null {
  const id = world.getId(x, y, z);
  if (id === EMPTY_ID) return null;
  const state = world.states.get(id);
  return state && state.parts.length === 0 ? state.semantic : null;
}

const isEmpty = (world: World, c: Vec3) => world.getId(c[0], c[1], c[2]) === EMPTY_ID;

/** The axis a face normal runs along, and the two across it. */
function axesOf(normal: Vec3): { axis: 0 | 1 | 2; u: 0 | 1 | 2; v: 0 | 1 | 2 } {
  const axis = normal[0] !== 0 ? 0 : normal[1] !== 0 ? 1 : 2;
  const [u, v] = ([0, 1, 2] as const).filter((a) => a !== axis) as [0 | 1 | 2, 0 | 1 | 2];
  return { axis, u, v };
}

function clampBrush(brush: number): number {
  return Math.max(1, Math.min(MAX_BRUSH, Math.floor(brush)));
}

/**
 * Build to me: from the cell a placement would fill, straight along the face's normal toward
 * the camera, stopping one short of the camera's cell. Only that one axis counts, so aiming
 * at a floor ten cells below lays nine blocks up. The brush widens it to a square. Cells
 * already full are skipped, never replaced. Nearest the face first.
 */
export function columnCells(world: World, aim: Aim, camera: Vec3, brush: number): Vec3[] {
  const place = aim.place;
  if (!place) return [];
  const { axis, u, v } = axesOf(aim.face);
  const step = aim.face[axis] > 0 ? 1 : -1;
  const count = Math.min(COLUMN_LIMIT, (Math.floor(camera[axis]) - place[axis]) * step);
  if (count <= 0) return [];
  const size = clampBrush(brush);
  const lo = -Math.floor((size - 1) / 2);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++)
    for (let du = 0; du < size; du++)
      for (let dv = 0; dv < size; dv++) {
        const c: [number, number, number] = [place[0], place[1], place[2]];
        c[axis] += step * i;
        c[u] += lo + du;
        c[v] += lo + dv;
        if (isEmpty(world, c)) out.push(c);
      }
  return out;
}

/**
 * The wand: the run of blocks of the clicked block's semantic that lie in the clicked face's
 * plane and touch it side by side, each gets a block on that face where the
 * cell is empty. So a stone wall with wooden ends grows only the stone, and a floor grows
 * one layer up wherever it is open. Reaches WAND_LIMIT cells each way; nearest the click first.
 */
export function wandCells(world: World, aim: Aim): Vec3[] {
  const block = aim.hit;
  if (!block) return [];
  const semantic = blockSemantic(world, ...block);
  if (semantic === null) return [];
  const { u, v } = axesOf(aim.face);
  const n = aim.face;
  const seen = new Set<string>([block.join()]);
  const queue: Vec3[] = [block];
  const out: { cell: Vec3; ring: number }[] = [];
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head] as Vec3;
    const t: Vec3 = [c[0] + n[0], c[1] + n[1], c[2] + n[2]];
    if (isEmpty(world, t)) {
      const ring = Math.max(Math.abs(c[u] - block[u]), Math.abs(c[v] - block[v]));
      out.push({ cell: t, ring });
    }
    for (const [a, d] of [
      [u, 1],
      [u, -1],
      [v, 1],
      [v, -1],
    ] as const) {
      const next: [number, number, number] = [c[0], c[1], c[2]];
      next[a] += d;
      if (Math.abs(next[u] - block[u]) > WAND_LIMIT || Math.abs(next[v] - block[v]) > WAND_LIMIT)
        continue;
      const key = next.join();
      if (seen.has(key)) continue;
      if (blockSemantic(world, ...next) !== semantic) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  // Breadth first already runs outward; sorting by ring makes it square rings, as Godot drew.
  return out.sort((a, b) => a.ring - b.ring).map((o) => o.cell);
}

/**
 * Exchange: swaps the clicked block, and the blocks of its semantic touching it in the
 * clicked face's plane out to the brush's reach, for the hotbar semantic, in place.
 * Brush 1 is the clicked block alone; brush 3 reaches one cell around it; never past the
 * connected run (a 2×2 patch of dirt in a stone wall changes only those four).
 */
export function exchangeCells(world: World, aim: Aim, brush: number): Vec3[] {
  const block = aim.hit;
  if (!block) return [];
  const semantic = blockSemantic(world, ...block);
  if (semantic === null) return [];
  const { u, v } = axesOf(aim.face);
  const reach = Math.floor((clampBrush(brush) - 1) / 2);
  const seen = new Set<string>([block.join()]);
  const out: Vec3[] = [block];
  for (let head = 0; head < out.length; head++) {
    const c = out[head] as Vec3;
    for (const [a, d] of [
      [u, 1],
      [u, -1],
      [v, 1],
      [v, -1],
    ] as const) {
      const next: [number, number, number] = [c[0], c[1], c[2]];
      next[a] += d;
      if (Math.abs(next[u] - block[u]) > reach || Math.abs(next[v] - block[v]) > reach) continue;
      const key = next.join();
      if (seen.has(key)) continue;
      if (blockSemantic(world, ...next) !== semantic) continue;
      seen.add(key);
      out.push(next);
    }
  }
  return out;
}

/** The cells a tool click would build: the preview and the command share it. */
export function toolCells(world: World, click: ToolClick): Vec3[] {
  if (click.tool === "column") return columnCells(world, click.aim, click.camera, click.brush);
  if (click.tool === "wand") return wandCells(world, click.aim);
  return exchangeCells(world, click.aim, click.brush);
}

const LABELS: Record<BuildTool, string> = {
  column: "Build to me",
  wand: "Wand",
  exchange: "Exchange",
};

/**
 * The `set` command a tool click runs, or null when there is nothing to build. Blocks are
 * turned as a click on that face picks. The wand keeps a turnable block's own turn where the
 * block it grows from has one the new semantic allows, so a run of mixed barrels stays mixed.
 */
export function toolCommand(
  project: Project,
  click: ToolClick,
  ref: SemanticArg,
  look: Vec3,
): Command | null {
  const semantic = semanticIdOf(project, ref);
  if (!project.semantics.has(semantic)) return null;
  const cells = toolCells(project.world, click);
  if (cells.length === 0) return null;
  const profile = project.placement(semantic);
  const picked = profile.pick({ face: click.aim.face, look, hitY: click.aim.hitY });
  const turnable = profile.allowed.length > 1;
  const states: { semantic: SemanticArg; rotation: number }[] = [];
  const index = new Map<number, number>();
  const stateFor = (rotation: number) => {
    let i = index.get(rotation);
    if (i === undefined) {
      i = states.length;
      index.set(rotation, i);
      states.push({ semantic: ref, rotation });
    }
    return i;
  };
  const flat: number[] = [];
  const n = click.aim.face;
  for (const c of cells) {
    let rotation = picked;
    if (click.tool === "wand" && turnable) {
      const from = project.world.get(c[0] - n[0], c[1] - n[1], c[2] - n[2]);
      if (from && from.parts.length === 0 && profile.allows(from.rotation))
        rotation = profile.fix(from.rotation);
    }
    flat.push(c[0], c[1], c[2], stateFor(rotation));
  }
  const name = project.semantics.nameOf(semantic);
  return {
    id: commandId(),
    kind: "set",
    source: EDITOR_SOURCE,
    label: `${LABELS[click.tool]}: ${cells.length} ${name}`,
    args: { states, cells: flat },
  };
}
