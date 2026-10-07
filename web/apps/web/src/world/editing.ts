// What the editor's clicks mean, as core commands: where the crosshair aims, what placing or
// removing there runs, and what the editor shows about the project (its semantics for the
// hotbar, what undo and redo would do). Every edit goes through Project.run, so it lands in
// the history with a label, undoes, and is the same command an agent would send.
// Runs in the world worker; pure functions over a Project, so they test in Node.

import { blockLabel } from "@voxyl/blocks";
import {
  type CellState,
  type Command,
  EMPTY_ID,
  type Look,
  NO_SEMANTIC,
  type PaletteId,
  Project,
  type Region,
  ROOT_PALETTE,
  raycast,
  regionStats,
  type SemanticArg,
  type SemanticId,
  stateInput,
  stateJSON,
  type World,
} from "@voxyl/core";
import { type BlockMaterials, lookColor } from "@voxyl/session";
import type { Vec3 } from "./protocol.ts";

/** Who the editor's commands say they are from, in the history. */
export const EDITOR_SOURCE = "editor";

/** Where the crosshair points: the cell it hits, and the empty cell a placement would fill. */
export interface Aim {
  /** The occupied cell hit, or null when the ray met the ground plane (or nothing). */
  readonly hit: Vec3 | null;
  /** The state id of the cell hit (EMPTY_ID on the ground). */
  readonly id: number;
  /** The empty cell a placement fills, or null (nothing in reach, or aiming from inside). */
  readonly place: Vec3 | null;
  /** The outward normal of the face aimed at. */
  readonly face: Vec3;
  /** How far up the face the ray meets it, 0 (bottom) to 1 (top). */
  readonly hitY: number;
}

/**
 * Casts the crosshair's ray. Past every cell it can rest on the ground plane, the top of
 * layer -1, so an empty world has somewhere to put the first block.
 */
export function aim(world: World, origin: Vec3, dir: Vec3, reach: number): Aim | null {
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  if (length === 0) return null;
  const d: Vec3 = [dir[0] / length, dir[1] / length, dir[2] / length];
  const hit = raycast(world, origin, d, reach);
  if (hit) {
    const [nx, ny, nz] = hit.normal;
    const [x, y, z] = hit.cell;
    const inside = nx === 0 && ny === 0 && nz === 0;
    const pointY = origin[1] + d[1] * hit.distance;
    return {
      hit: [x, y, z],
      id: hit.id,
      place: inside ? null : [x + nx, y + ny, z + nz],
      face: hit.normal,
      hitY: ny === 0 ? Math.min(1, Math.max(0, pointY - y)) : ny > 0 ? 1 : 0,
    };
  }
  // The ground: only looking down at it from above, within reach.
  if (d[1] >= 0 || origin[1] <= 0) return null;
  const t = -origin[1] / d[1];
  if (t > reach) return null;
  const place: Vec3 = [Math.floor(origin[0] + d[0] * t), 0, Math.floor(origin[2] + d[2] * t)];
  if (world.getId(...place) !== EMPTY_ID) return null; // the ray passed through it: not ground
  return { hit: null, id: EMPTY_ID, place, face: [0, 1, 0], hitY: 1 };
}

/** The semantic a state is picked as: its block's, or its first part's. */
export function semanticOfState(state: CellState): SemanticId {
  return state.parts[0]?.semantic ?? state.semantic;
}

/** The semantic an argument names now: its id, or the base it would be derived from. */
function semanticIdOf(project: Project, ref: SemanticArg): SemanticId {
  if (typeof ref === "number") return ref;
  // Derived already? Then that one (its form may override the base's).
  const own = project.semantics
    .semanticsIn(ref.palette)
    .find((s) => project.semantics.get(s).base === ref.base);
  return own ?? ref.base;
}

let nextId = 0;
/** A command id unique to this editor session. */
function commandId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `editor-${++nextId}-${random}`;
}

/**
 * The command that places `ref` where the aim says, turned as the semantic's placement
 * profile picks from the click, or null if there is nowhere to place.
 */
export function placeCommand(
  project: Project,
  target: Aim,
  ref: SemanticArg,
  look: Vec3,
): Command | null {
  if (!target.place) return null;
  // A full cell stays: placement fills empty space, the way a click against a solid face does.
  if (project.world.getId(...target.place) !== EMPTY_ID) return null;
  const semantic = semanticIdOf(project, ref);
  if (!project.semantics.has(semantic)) return null;
  const rotation = project.placement(semantic).pick({
    face: target.face,
    look,
    hitY: target.hitY,
  });
  return {
    id: commandId(),
    kind: "set",
    source: EDITOR_SOURCE,
    label: `Place ${project.semantics.nameOf(semantic)}`,
    args: { states: [{ semantic: ref, rotation }], cells: [...target.place, 0] },
  };
}

/** The command that empties the cell aimed at, or null if the aim is on the ground. */
export function eraseCommand(project: Project, target: Aim): Command | null {
  if (!target.hit) return null;
  const state = project.world.states.get(target.id);
  const name = state ? project.semantics.nameOf(semanticOfState(state)) : "";
  return {
    id: commandId(),
    kind: "set",
    source: EDITOR_SOURCE,
    label: name ? `Remove ${name}` : "Remove",
    args: { states: [null], cells: [...target.hit, 0] },
  };
}

/** The command that writes state `id` (EMPTY_ID clears) into one cell: scripted edits. */
export function setCellCommand(project: Project, at: Vec3, id: number, label: string): Command {
  const state = id === EMPTY_ID ? null : project.world.states.get(id);
  return {
    id: commandId(),
    kind: "set",
    source: EDITOR_SOURCE,
    label,
    args: { states: [state ? stateInput(stateJSON(state)) : null], cells: [...at, 0] },
  };
}

/** The command that sets the selection (null clears it). Selecting is not an undo step. */
export function selectCommand(where: Region | null): Command {
  return {
    id: commandId(),
    kind: "select",
    source: EDITOR_SOURCE,
    label: where === null ? "Clear selection" : "Select",
    args: { where },
  };
}

/**
 * Fills the selection, empty cells included, with one semantic. Its rotation is the one a
 * click on top of a block would pick while looking `look`, so stairs face the player.
 */
export function fillSelectionCommand(
  project: Project,
  ref: SemanticArg,
  look: Vec3,
): Command | null {
  if (!project.selection || project.selection.size === 0) return null;
  const semantic = semanticIdOf(project, ref);
  if (!project.semantics.has(semantic)) return null;
  return {
    id: commandId(),
    kind: "fill",
    source: EDITOR_SOURCE,
    label: `Fill with ${project.semantics.nameOf(semantic)}`,
    args: {
      where: { selection: true },
      state: { semantic: ref, rotation: rotationFor(project, semantic, look) },
    },
  };
}

/** Empties the selection. */
export function clearSelectionCommand(project: Project): Command | null {
  if (!project.selection || project.selection.size === 0) return null;
  return {
    id: commandId(),
    kind: "clear",
    source: EDITOR_SOURCE,
    label: "Clear selection",
    args: { where: { selection: true } },
  };
}

/**
 * Turns every occupied cell in the selection into a whole block of `ref` (empty cells stay
 * empty). Parts become whole blocks; re-semantic is the one that keeps their shape.
 */
export function replaceSelectionCommand(
  project: Project,
  ref: SemanticArg,
  look: Vec3,
): Command | null {
  if (!project.selection || project.selection.size === 0) return null;
  const stats = regionStats(project, { selection: true });
  const ids = [
    ...new Set([
      ...stats.blocks.map((block) => block.semantic),
      ...stats.parts.map((part) => part.semantic),
    ]),
  ];
  if (ids.length === 0) return null;
  const occupied: Region =
    ids.length === 1
      ? { all: [{ selection: true }, { semantic: ids[0] ?? 0 }] }
      : { all: [{ selection: true }, { any: ids.map((semantic) => ({ semantic })) }] };
  const semantic = semanticIdOf(project, ref);
  if (!project.semantics.has(semantic)) return null;
  return {
    id: commandId(),
    kind: "fill",
    source: EDITOR_SOURCE,
    label: `Replace with ${project.semantics.nameOf(semantic)}`,
    args: {
      where: occupied,
      state: { semantic: ref, rotation: rotationFor(project, semantic, look) },
    },
  };
}

/** Switches one semantic for another inside the selection, keeping each cell's geometry. */
export function resemanticSelectionCommand(
  project: Project,
  from: SemanticArg,
  to: SemanticArg,
): Command | null {
  if (!project.selection || project.selection.size === 0) return null;
  const a = semanticIdOf(project, from);
  const b = semanticIdOf(project, to);
  if (a === b || !project.semantics.has(a) || !project.semantics.has(b)) return null;
  return {
    id: commandId(),
    kind: "resemantic",
    source: EDITOR_SOURCE,
    label: `${project.semantics.nameOf(a)} to ${project.semantics.nameOf(b)}`,
    args: { where: { selection: true }, from, to },
  };
}

/** The rotation a region fill stores: as if the block were placed on a top face. */
function rotationFor(project: Project, semantic: SemanticId, look: Vec3): number {
  return project.placement(semantic).pick({ face: [0, 1, 0], look, hitY: 1 });
}

/** The command that fills a box with state `id` (EMPTY_ID clears it). */
export function fillBoxCommand(
  project: Project,
  from: Vec3,
  to: Vec3,
  id: number,
  label: string,
): Command {
  const state = id === EMPTY_ID ? null : project.world.states.get(id);
  const where = { box: [...from, ...to] }; // opposite corners, inclusive, in any order
  return state
    ? {
        id: commandId(),
        kind: "fill",
        source: EDITOR_SOURCE,
        label,
        args: { where, state: stateInput(stateJSON(state)) },
      }
    : { id: commandId(), kind: "clear", source: EDITOR_SOURCE, label, args: { where } };
}

/** The command that adds a semantic to a palette, or null if the name is empty. */
export function addSemanticCommand(
  project: Project,
  palette: PaletteId,
  name: string,
): Command | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 80 || !project.semantics.hasPalette(palette)) return null;
  return {
    id: commandId(),
    kind: "semantic_add",
    source: EDITOR_SOURCE,
    label: `Add ${trimmed}`,
    args: { name: trimmed, palette },
  };
}

/** The command that renames a semantic, deriving it first when it is only offered. */
export function renameSemanticCommand(
  project: Project,
  ref: SemanticArg,
  name: string,
): Command | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 80) return null;
  const current = project.semantics.nameOf(typeof ref === "number" ? ref : ref.base);
  if (trimmed === current) return null;
  return {
    id: commandId(),
    kind: "semantic_update",
    source: EDITOR_SOURCE,
    label: `Rename ${current} to ${trimmed}`,
    args: { semantic: ref, name: trimmed },
  };
}

/**
 * The command that sets the look a semantic stores itself (null goes back to inheriting it).
 * Null when the look would not change. Only the fields given are stored, so a derived
 * semantic can override its glow without freezing the block it inherits.
 */
export function setLookCommand(
  project: Project,
  ref: SemanticArg,
  look: Look | null,
): Command | null {
  const before = storedLook(project, ref);
  if (sameLook(before, look)) return null;
  const name = project.semantics.nameOf(typeof ref === "number" ? ref : ref.base);
  return {
    id: commandId(),
    kind: "semantic_update",
    source: EDITOR_SOURCE,
    label: lookLabel(name, before, look),
    args: { semantic: ref, look },
  };
}

/** The command that adds a palette, optionally extending another. */
export function addPaletteCommand(
  project: Project,
  name: string,
  parent?: PaletteId,
): Command | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 80) return null;
  if (parent !== undefined && !project.semantics.hasPalette(parent)) return null;
  return {
    id: commandId(),
    kind: "palette_add",
    source: EDITOR_SOURCE,
    label: `Add palette ${trimmed}`,
    args: { name: trimmed, ...(parent !== undefined && { extends: parent }) },
  };
}

/** The command that renames a palette, or null if the name is empty or the same. */
export function renamePaletteCommand(
  project: Project,
  palette: PaletteId,
  name: string,
): Command | null {
  const trimmed = name.trim();
  const current = project.semantics.palette(palette);
  if (trimmed === "" || trimmed === current.name || trimmed.length > 80) return null;
  return {
    id: commandId(),
    kind: "palette_update",
    source: EDITOR_SOURCE,
    label: `Rename palette ${current.name} to ${trimmed}`,
    args: { palette, name: trimmed },
  };
}

/** The look a semantic stores itself, or none when it doesn't exist yet or inherits all of it. */
function storedLook(project: Project, ref: SemanticArg): Look | undefined {
  if (typeof ref === "number")
    return project.semantics.has(ref) ? project.semantics.get(ref).look : undefined;
  const own = project.semantics
    .semanticsIn(ref.palette)
    .find((s) => project.semantics.get(s).base === ref.base);
  return own === undefined ? undefined : project.semantics.get(own).look;
}

function sameLook(before: Look | undefined, after: Look | null): boolean {
  const left = before ?? {};
  const right = after ?? {};
  return left.block === right.block && left.glow === right.glow && left.tint === right.tint;
}

function lookLabel(name: string, before: Look | undefined, after: Look | null): string {
  if (after === null) return `${name} uses its base look`;
  if (before?.block !== after.block) {
    return after.block ? `${name} looks like ${blockLabel(after.block)}` : `${name} is undecided`;
  }
  if ((before?.glow === true) !== (after.glow === true)) {
    return after.glow ? `${name} glows` : `${name} stops glowing`;
  }
  if (after.tint) return `${name} coloured ${after.tint}`;
  return `Change ${name}'s look`;
}

/** The command that renames the project, or null if the name is empty or the same. */
export function renameCommand(project: Project, name: string): Command | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === project.settings.name) return null;
  return {
    id: commandId(),
    kind: "settings",
    source: EDITOR_SOURCE,
    label: `Rename to ${trimmed}`,
    args: { name: trimmed },
  };
}

/** The undo (or redo) command for the latest step, or null if there is none. */
export function stepCommand(project: Project, kind: "undo" | "redo"): Command | null {
  const target = kind === "undo" ? project.undoTarget() : project.redoTarget();
  if (target === null) return null;
  return { id: commandId(), kind, source: EDITOR_SOURCE, args: { target } };
}

/** What undo and redo would do now, as the labels of their steps (null when nothing). */
export interface HistoryState {
  readonly undo: string | null;
  readonly redo: string | null;
}

export function historyState(project: Project): HistoryState {
  const labelOf = (id: string | null) => {
    if (id === null) return null;
    const entry = project.history.find((e) => e.command.id === id);
    return entry?.command.label ?? entry?.command.kind ?? "";
  };
  return { undo: labelOf(project.undoTarget()), redo: labelOf(project.redoTarget()) };
}

/** A semantic as the editor lists it: how to place it, and how to show it. */
export interface SemanticInfo {
  /** What a command names to place it (an id, or the base it derives from on first use). */
  readonly ref: SemanticArg;
  /** The palette it is offered in, and the ancestor's semantic it derives (or would) from. */
  readonly palette: PaletteId;
  readonly base?: SemanticId;
  readonly name: string;
  /** "#rrggbb": its block's average colour, else its tint. */
  readonly color: string;
  readonly glow: boolean;
  /** The block its look names ("library:block"), or none while undecided. */
  readonly block?: string;
  /** The look it sets itself. Empty when it inherits the whole look. */
  readonly ownLook: Look;
}

export interface PaletteInfo {
  readonly id: PaletteId;
  readonly name: string;
  /** A linked copy of a shared palette (read-only in the project). */
  readonly linked: boolean;
  readonly extends?: PaletteId;
  /** What it can place: its own semantics, then ones it derives from its ancestors. */
  readonly semantics: readonly SemanticInfo[];
}

/** Every palette and what it can place, root palette first. */
export function paletteInfo(project: Project, blocks?: BlockMaterials): PaletteInfo[] {
  const registry = project.semantics;
  const palettes = registry.palettes().sort((a, b) => {
    if (a.id === ROOT_PALETTE) return -1;
    if (b.id === ROOT_PALETTE) return 1;
    return a.id - b.id;
  });
  return palettes.map((palette) => ({
    id: palette.id,
    name: palette.name,
    linked: palette.linked !== undefined,
    ...(palette.extends !== undefined && { extends: palette.extends }),
    semantics: registry.offers(palette.id).map((offer): SemanticInfo => {
      const id = offer.id ?? offer.base ?? NO_SEMANTIC;
      const { look } = registry.resolve(id);
      const ref: SemanticArg =
        offer.id !== undefined ? offer.id : { palette: palette.id, base: offer.base ?? 0 };
      const base = offer.id !== undefined ? registry.get(offer.id).base : offer.base;
      const ownLook = offer.id !== undefined ? registry.get(offer.id).look : undefined;
      return {
        ref,
        palette: palette.id,
        ...(base !== undefined && { base }),
        name: offer.name,
        color: lookColor(look, blocks),
        glow: look.glow === true,
        ...(look.block !== undefined && { block: look.block }),
        ownLook: ownLook ?? {},
      };
    }),
  }));
}

/**
 * The semantics a new project starts with: undecided (no block yet, principle 5), each with
 * a hint colour so they tell apart. Names are intent, for any kind of voxel build.
 */
export const STARTER_SEMANTICS: readonly {
  name: string;
  tint: string;
  glow?: boolean;
}[] = [
  { name: "Base", tint: "#8d8f94" },
  { name: "Wall", tint: "#d9d4c7" },
  { name: "Floor", tint: "#9a7b5a" },
  { name: "Roof", tint: "#5b6470" },
  { name: "Trim", tint: "#f2f2ef" },
  { name: "Accent", tint: "#22b8cf" },
  { name: "Glass", tint: "#a9d8e8" },
  { name: "Light", tint: "#ffd36b", glow: true },
  { name: "Detail", tint: "#6b4f3a" },
];

/** A new, empty project with the starter semantics in its root palette. */
export function newProject(name: string, chunkBits: number): Project {
  const project = new Project({ chunkBits });
  project.run({
    id: "new-settings",
    kind: "settings",
    source: EDITOR_SOURCE,
    args: { ...project.settings, name },
  });
  STARTER_SEMANTICS.forEach((s, i) => {
    project.run({
      id: `new-semantic-${i}`,
      kind: "semantic_add",
      source: EDITOR_SOURCE,
      args: {
        palette: ROOT_PALETTE,
        name: s.name,
        look: { tint: s.tint, ...(s.glow && { glow: true }) },
      },
    });
  });
  return project;
}
