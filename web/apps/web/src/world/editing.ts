// What the editor's clicks mean, as core commands: where the crosshair aims, what placing or
// removing there runs, and what the editor shows about the project (its semantics for the
// hotbar, what undo and redo would do). Every edit goes through Project.run, so it lands in
// the history with a label, undoes, and is the same command an agent would send.
// Runs in the world worker; pure functions over a Project, so they test in Node.

import { blockLabel } from "@voxyl/blocks";
import {
  type CellState,
  type Command,
  type Direction,
  EMPTY_ID,
  type Form,
  type Look,
  NO_SEMANTIC,
  type PaletteId,
  type Part,
  PLACEMENTS,
  type PlacementProfile,
  Project,
  type Region,
  ROOT_PALETTE,
  raycast,
  regionStats,
  type SemanticArg,
  type SemanticId,
  type SharedPalette,
  sideOf,
  stateInput,
  stateJSON,
  type World,
} from "@voxyl/core";
import { type BlockMaterials, lookColor } from "@voxyl/session";
import { type PartPlacement, resolvePlacement, sideFromNormal } from "@voxyl/shapes";
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
  /** Where the ray met it, in world coordinates. */
  readonly point?: Vec3;
  /** For a cell of parts: the part the ray met, and the outward side of the face it hit. */
  readonly part?: { readonly index: number; readonly side: number };
}

/**
 * Casts the crosshair's ray. Past every cell it can rest on the ground plane, the top of
 * layer -1, so an empty world has somewhere to put the first block. Cells `hidden` says are
 * hidden (a cutaway) are not there to hit.
 */
export function aim(
  world: World,
  origin: Vec3,
  dir: Vec3,
  reach: number,
  hidden?: (x: number, y: number, z: number) => boolean,
): Aim | null {
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  if (length === 0) return null;
  const d: Vec3 = [dir[0] / length, dir[1] / length, dir[2] / length];
  const hit = raycast(world, origin, d, reach, hidden);
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
      point: hit.point,
      ...(hit.part && { part: hit.part }),
    };
  }
  // The ground: only looking down at it from above, within reach.
  if (d[1] >= 0 || origin[1] <= 0) return null;
  const t = -origin[1] / d[1];
  if (t > reach) return null;
  const place: Vec3 = [Math.floor(origin[0] + d[0] * t), 0, Math.floor(origin[2] + d[2] * t)];
  if (world.getId(...place) !== EMPTY_ID) return null; // the ray passed through it: not ground
  return {
    hit: null,
    id: EMPTY_ID,
    place,
    face: [0, 1, 0],
    hitY: 1,
    point: [origin[0] + d[0] * t, 0, origin[2] + d[2] * t],
  };
}

/** The semantic a state is picked as: its block's, or its first part's. */
export function semanticOfState(state: CellState): SemanticId {
  return state.parts[0]?.semantic ?? state.semantic;
}

/** The semantic an argument names now: its id, or the base it would be derived from. */
export function semanticIdOf(project: Project, ref: SemanticArg): SemanticId {
  if (typeof ref === "number") return ref;
  // Derived already? Then that one (its form may override the base's).
  const own = project.semantics
    .semanticsIn(ref.palette)
    .find((s) => project.semantics.get(s).base === ref.base);
  return own ?? ref.base;
}

let nextId = 0;
/** A command id unique to this editor session. */
export function commandId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `editor-${++nextId}-${random}`;
}

/**
 * The command that places `ref` where the aim says, turned as the semantic's placement
 * profile picks from the click, or null if there is nowhere to place. A semantic whose form
 * names a shape places a part of that shape instead (see partPlacement); `opposite` is the
 * modifier that puts it on the far side.
 */
export function placeCommand(
  project: Project,
  target: Aim,
  ref: SemanticArg,
  look: Vec3,
  opposite = false,
): Command | null {
  const semantic = semanticIdOf(project, ref);
  if (!project.semantics.has(semantic)) return null;
  const shape = project.semantics.resolve(semantic).form.shape;
  if (shape !== undefined) return placePartCommand(project, target, ref, shape, opposite);
  if (!target.place) return null;
  // A full cell stays: placement fills empty space, the way a click against a solid face does.
  if (project.world.getId(...target.place) !== EMPTY_ID) return null;
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

/** The parts of a cell for the placement rules: [] when empty, null for a whole block. */
function partsAt(world: World, cell: Vec3): readonly Part[] | null {
  if (
    !world.layout.isWorldCoord(cell[0]) ||
    !world.layout.isWorldCoord(cell[1]) ||
    !world.layout.isWorldCoord(cell[2])
  ) {
    return null;
  }
  const state = world.get(...cell);
  if (!state) return [];
  return state.parts.length > 0 ? state.parts : null;
}

/**
 * Where a part of `shape` would land for the aim: the cell and the slot, from where on which
 * face the ray met. Aiming at the ground treats the plane as the top of a block under it.
 */
export function partPlacement(
  project: Project,
  target: Aim,
  semantic: SemanticId,
  shape: string,
  opposite: boolean,
): PartPlacement | null {
  const point = target.point;
  if (!point) return null;
  let cell: Vec3;
  let side: number;
  if (target.hit) {
    cell = target.hit;
    if (target.part) side = target.part.side;
    else if (target.face[0] === 0 && target.face[1] === 0 && target.face[2] === 0) return null;
    else side = sideFromNormal(target.face);
  } else if (target.place) {
    cell = [target.place[0], target.place[1] - 1, target.place[2]];
    side = 1;
  } else {
    return null;
  }
  const vhit: Vec3 = [point[0] - cell[0], point[1] - cell[1], point[2] - cell[2]];
  return resolvePlacement(
    { parts: (c) => partsAt(project.world, c) },
    semantic,
    shape,
    cell,
    vhit,
    side,
    opposite,
  );
}

/** A cell of parts as the arguments of a set: the parts it keeps, or null when none are left. */
function partsState(
  state: CellState,
  parts: readonly Part[] | readonly PartArg[],
): StateArg | null {
  if (parts.length === 0) return null;
  return {
    parts: parts.map((p) => ({ semantic: p.semantic, shape: p.shape, slot: p.slot })),
    ...(Object.keys(state.tags).length > 0 && { tags: state.tags }),
  };
}

interface PartArg {
  readonly semantic: SemanticArg;
  readonly shape: string;
  readonly slot: number;
}

/** A set command's state: parts and tags (the whole-block form is built inline). */
interface StateArg {
  readonly parts: readonly PartArg[];
  readonly tags?: CellState["tags"];
}

function placePartCommand(
  project: Project,
  target: Aim,
  ref: SemanticArg,
  shape: string,
  opposite: boolean,
): Command | null {
  const semantic = semanticIdOf(project, ref);
  const placed = partPlacement(project, target, semantic, shape, opposite);
  if (!placed) return null;
  const existing = project.world.get(...placed.cell);
  const parts: PartArg[] = [
    ...(existing?.parts ?? []).map((p) => ({ semantic: p.semantic, shape: p.shape, slot: p.slot })),
    { semantic: ref, shape, slot: placed.slot },
  ];
  const state = partsState(existing ?? EMPTY_STATE, parts);
  return {
    id: commandId(),
    kind: "set",
    source: EDITOR_SOURCE,
    label: `Place ${project.semantics.nameOf(semantic)}`,
    args: { states: [state], cells: [...placed.cell, 0] },
  };
}

const EMPTY_STATE: CellState = { semantic: NO_SEMANTIC, rotation: 0, tags: {}, parts: [] };

/** What a placement would put down: a shape in a slot of a cell, for the ghost. */
export interface PartGhost {
  readonly cell: Vec3;
  readonly shape: string;
  readonly slot: number;
}

/** The part the semantic would place at the aim, or null (no shape, or nowhere to put it). */
export function partGhost(
  project: Project,
  target: Aim,
  ref: SemanticArg,
  opposite: boolean,
): PartGhost | null {
  const semantic = semanticIdOf(project, ref);
  if (!project.semantics.has(semantic)) return null;
  const shape = project.semantics.resolve(semantic).form.shape;
  if (shape === undefined) return null;
  const placed = partPlacement(project, target, semantic, shape, opposite);
  return placed ? { cell: placed.cell, shape, slot: placed.slot } : null;
}

/**
 * The command that empties the cell aimed at, or null if the aim is on the ground. In a cell
 * of parts it takes out only the part the ray met.
 */
export function eraseCommand(project: Project, target: Aim): Command | null {
  if (!target.hit) return null;
  const state = project.world.states.get(target.id);
  if (state && state.parts.length > 0 && target.part) {
    const gone = state.parts[target.part.index];
    if (gone) {
      const left = state.parts.filter((_, i) => i !== target.part?.index);
      const name = project.semantics.nameOf(gone.semantic);
      return {
        id: commandId(),
        kind: "set",
        source: EDITOR_SOURCE,
        label: name ? `Remove ${name}` : "Remove",
        args: { states: [partsState(state, left)], cells: [...target.hit, 0] },
      };
    }
  }
  const name = state ? project.semantics.nameOf(semanticOfState(state)) : "";
  return {
    id: commandId(),
    kind: "set",
    source: EDITOR_SOURCE,
    label: name ? `Remove ${name}` : "Remove",
    args: { states: [null], cells: [...target.hit, 0] },
  };
}

/**
 * The command that turns the block aimed at a quarter turn about the face it hits, clockwise
 * as seen looking at that face (`reverse`: anticlockwise). Null when the aim is on the ground.
 */
export function rotateCommand(project: Project, target: Aim, reverse: boolean): Command | null {
  if (!target.hit) return null;
  const state = project.world.states.get(target.id);
  const name = state ? project.semantics.nameOf(semanticOfState(state)) : "";
  return {
    id: commandId(),
    kind: "rotate",
    source: EDITOR_SOURCE,
    label: name ? `Turn ${name}` : "Turn",
    args: {
      where: { box: [...target.hit, ...target.hit] },
      face: sideOf(target.face),
      turns: reverse ? -1 : 1,
    },
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
  extras?: { readonly description?: string; readonly look?: Look; readonly form?: Form },
): Command | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 80 || !project.semantics.hasPalette(palette)) return null;
  const description = extras?.description?.trim().slice(0, 400);
  const look = extras?.look;
  return {
    id: commandId(),
    kind: "semantic_add",
    source: EDITOR_SOURCE,
    label: `Add ${trimmed}`,
    args: {
      name: trimmed,
      palette,
      ...(description ? { description } : {}),
      ...(look && (look.block || look.glow || look.tint) ? { look } : {}),
      ...(extras?.form && (extras.form.shape || extras.form.placement)
        ? { form: extras.form }
        : {}),
    },
  };
}

/**
 * One step that renames a semantic and sets what it is for and what it looks like. Null when
 * nothing would change. A semantic the palette only offers is derived first, by the ref.
 */
export function editSemanticCommand(
  project: Project,
  ref: SemanticArg,
  fields: {
    readonly name: string;
    readonly description: string;
    readonly look: Look | null;
    /** The form the semantic sets itself (undefined leaves it alone, null drops it). */
    readonly form?: Form | null;
  },
): Command | null {
  const name = fields.name.trim();
  if (name === "" || name.length > 80) return null;
  const description = fields.description.trim().slice(0, 400);
  const id = typeof ref === "number" ? ref : ref.base;
  if (!project.semantics.has(id)) return null;
  const nameSame = name === project.semantics.nameOf(id);
  const descSame = description === (project.semantics.resolve(id).description ?? "");
  const lookSame = sameLook(storedLook(project, ref), fields.look);
  const formSame = fields.form === undefined || sameForm(storedForm(project, ref), fields.form);
  if (nameSame && descSame && lookSame && formSame) return null;
  return {
    id: commandId(),
    kind: "semantic_update",
    source: EDITOR_SOURCE,
    label: `Edit ${name}`,
    args: {
      semantic: ref,
      ...(nameSame ? {} : { name }),
      ...(descSame ? {} : { description: description === "" ? null : description }),
      ...(lookSame ? {} : { look: fields.look }),
      ...(formSame ? {} : { form: fields.form }),
    },
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

/** The form a semantic stores itself, or none when it doesn't exist yet or inherits all of it. */
function storedForm(project: Project, ref: SemanticArg): Form | undefined {
  if (typeof ref === "number")
    return project.semantics.has(ref) ? project.semantics.get(ref).form : undefined;
  const own = project.semantics
    .semanticsIn(ref.palette)
    .find((s) => project.semantics.get(s).base === ref.base);
  return own === undefined ? undefined : project.semantics.get(own).form;
}

function sameForm(before: Form | undefined, after: Form | null): boolean {
  return JSON.stringify(before ?? {}) === JSON.stringify(after ?? {});
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

/** The command that removes a semantic (refused while cells use it). Null if it is offered only. */
export function removeSemanticCommand(project: Project, ref: SemanticArg): Command | null {
  if (typeof ref !== "number" || !project.semantics.has(ref)) return null;
  return {
    id: commandId(),
    kind: "semantic_remove",
    source: EDITOR_SOURCE,
    label: `Remove ${project.semantics.nameOf(ref)}`,
    args: { semantic: ref },
  };
}

/** The command that sets what a semantic is for (empty clears it), or null if unchanged. */
export function describeSemanticCommand(
  project: Project,
  ref: SemanticArg,
  description: string,
): Command | null {
  const text = description.trim().slice(0, 400);
  const id = typeof ref === "number" ? ref : ref.base;
  if (!project.semantics.has(id)) return null;
  const current = project.semantics.resolve(id).description ?? "";
  if (typeof ref === "number" && text === current) return null;
  const name = project.semantics.nameOf(id);
  return {
    id: commandId(),
    kind: "semantic_update",
    source: EDITOR_SOURCE,
    label: `Describe ${name}`,
    args: { semantic: ref, description: text === "" ? null : text },
  };
}

/**
 * A project palette as a shared palette, for "Share as a palette": everything it can place,
 * with its names, descriptions, forms and looks as they resolve now (inherited ones included),
 * keyed by semantic id so sharing it again matches the same semantics.
 */
export function sharedFromPalette(
  project: Project,
  palette: PaletteId,
  key: string,
): Omit<SharedPalette, "version"> {
  const registry = project.semantics;
  const p = registry.palette(palette);
  return {
    key,
    name: p.name,
    semantics: registry.offers(palette).map((offer) => {
      const id = offer.id ?? offer.base ?? NO_SEMANTIC;
      const resolved = registry.resolve(id);
      return {
        key: `s${id}`,
        name: offer.name,
        ...(resolved.description && { description: resolved.description }),
        ...(resolved.form && { form: resolved.form }),
        ...(Object.keys(resolved.look).length > 0 && { look: resolved.look }),
      };
    }),
  };
}

/**
 * The command that turns a project palette into the linked copy of the shared palette it was
 * just shared as (see sharedFromPalette): its own semantics keep their ids and are matched to
 * the shared ones by the same `s<id>` keys. Null for a palette that can't link (see the
 * registry's link): one that extends another, derives, or is already linked.
 */
export function linkExistingCommand(
  project: Project,
  palette: PaletteId,
  shared: { readonly key: string; readonly version: number; readonly name: string },
): Command | null {
  const registry = project.semantics;
  if (!registry.hasPalette(palette) || !canLink(project, palette)) return null;
  const keys: Record<string, string> = {};
  for (const id of registry.semanticsIn(palette)) keys[String(id)] = `s${id}`;
  return {
    id: commandId(),
    kind: "palette_link",
    source: EDITOR_SOURCE,
    label: `Share ${registry.palette(palette).name} (v${shared.version})`,
    args: { palette, key: shared.key, version: shared.version, keys },
  };
}

/** Whether a palette can become a linked copy of a shared palette: it stands alone. */
export function canLink(project: Project, palette: PaletteId): boolean {
  const registry = project.semantics;
  const p = registry.palette(palette);
  if (p.linked || p.extends !== undefined) return false;
  return registry.semanticsIn(palette).every((s) => registry.get(s).base === undefined);
}

/** The command that makes a linked copy an ordinary palette again. */
export function unlinkPaletteCommand(project: Project, palette: PaletteId): Command | null {
  if (!project.semantics.hasPalette(palette) || !project.semantics.palette(palette).linked) {
    return null;
  }
  return {
    id: commandId(),
    kind: "palette_unlink",
    source: EDITOR_SOURCE,
    label: `Make ${project.semantics.palette(palette).name} a local copy`,
    args: { palette },
  };
}

/**
 * The command that brings a shared palette in as a linked copy, or re-syncs the copy. A
 * project palette with the same name keeps it: the copy is called "Name (shared)".
 */
export function linkPaletteCommand(project: Project, shared: SharedPalette): Command {
  const taken = new Set(
    project.semantics
      .palettes()
      .filter((p) => p.linked?.key !== shared.key)
      .map((p) => p.name),
  );
  let name = shared.name;
  for (let n = 1; taken.has(name); n++)
    name = n === 1 ? `${shared.name} (shared)` : `${shared.name} (shared ${n})`;
  return {
    id: commandId(),
    kind: "palette_sync",
    source: EDITOR_SOURCE,
    label: `Use ${shared.name} (v${shared.version})`,
    args: {
      key: shared.key,
      version: shared.version,
      name,
      ...(shared.description !== undefined && { description: shared.description }),
      semantics: shared.semantics.map((s) => ({ ...s })),
    },
  };
}

/**
 * The command that changes which direction is the real north and where the major grid falls,
 * or null when nothing would change. Cells never move; north turns what crosses in or out.
 */
export function settingsCommand(
  project: Project,
  patch: { readonly north?: Direction; readonly grid?: readonly [number, number] },
): Command | null {
  const now = project.settings;
  const north = patch.north !== undefined && patch.north !== now.north ? patch.north : undefined;
  const grid =
    patch.grid !== undefined && (patch.grid[0] !== now.grid[0] || patch.grid[1] !== now.grid[1])
      ? patch.grid
      : undefined;
  if (north === undefined && grid === undefined) return null;
  return {
    id: commandId(),
    kind: "settings",
    source: EDITOR_SOURCE,
    label:
      north !== undefined && grid !== undefined
        ? "Change north and the grid"
        : north !== undefined
          ? `North is now ${north === "north" ? "-Z (the default)" : north}`
          : `Grid offset ${grid?.[0]}, ${grid?.[1]}`,
    args: { ...(north !== undefined && { north }), ...(grid !== undefined && { grid }) },
  };
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
  /** What it is for, in words (inherited like the name). */
  readonly description: string;
  /** "#rrggbb": its block's average colour, else its tint. */
  readonly color: string;
  readonly glow: boolean;
  /** The block its look names ("library:block"), or none while undecided. */
  readonly block?: string;
  /** The look it sets itself. Empty when it inherits the whole look. */
  readonly ownLook: Look;
  /** The shape it places as parts (resolved, so inherited), or none for whole blocks. */
  readonly shape?: string;
  /** The form it sets itself. Empty when it inherits all of it. */
  readonly ownForm: Form;
  /** How whole blocks of it may be turned, as a preset name; see placementName. */
  readonly placement: string;
}

/** The placing presets a semantic can pick, by name, with what each does. */
export const PLACEMENT_CHOICES: readonly { readonly id: string; readonly label: string }[] = [
  { id: "auto", label: "From the block it looks like" },
  { id: "cube", label: "Any way: a plain cube" },
  { id: "horizontal", label: "Faces the player, four ways" },
  { id: "stairs", label: "Stairs: faces the player, up or down" },
  { id: "slab", label: "Slab: up or down" },
  { id: "log", label: "Log: along the face clicked" },
  { id: "facing", label: "Points toward the player" },
  { id: "torch", label: "Torch: attaches to a face" },
  { id: "hopper", label: "Hopper: points into a face" },
];

/** The preset a placement profile is: "auto" for none, "custom" when it matches no preset. */
export function placementName(profile: PlacementProfile | undefined): string {
  if (profile === undefined) return "auto";
  const wanted = JSON.stringify(profile);
  for (const [name, preset] of Object.entries(PLACEMENTS)) {
    if (JSON.stringify(preset) === wanted) return name;
  }
  return "custom";
}

/** The profile a preset name means, or undefined for "auto". */
export function placementOf(name: string): PlacementProfile | undefined {
  return (PLACEMENTS as Record<string, PlacementProfile>)[name];
}

export interface PaletteInfo {
  readonly id: PaletteId;
  readonly name: string;
  /** It stands alone (extends nothing, derives nothing), so it can be made a shared palette. */
  readonly canLink: boolean;
  /** A linked copy of a shared palette (read-only in the project). */
  readonly linked: boolean;
  /** For a linked copy: the shared palette's key and the version the copy has. */
  readonly linkedKey?: string;
  readonly linkedVersion?: number;
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
    canLink: canLink(project, palette.id),
    linked: palette.linked !== undefined,
    ...(palette.linked && {
      linkedKey: palette.linked.key,
      linkedVersion: palette.linked.version,
    }),
    ...(palette.extends !== undefined && { extends: palette.extends }),
    semantics: registry.offers(palette.id).map((offer): SemanticInfo => {
      const id = offer.id ?? offer.base ?? NO_SEMANTIC;
      const { look, description, form } = registry.resolve(id);
      const ref: SemanticArg =
        offer.id !== undefined ? offer.id : { palette: palette.id, base: offer.base ?? 0 };
      const base = offer.id !== undefined ? registry.get(offer.id).base : offer.base;
      const stored = offer.id !== undefined ? registry.get(offer.id) : undefined;
      const ownLook = stored?.look;
      return {
        ref,
        palette: palette.id,
        ...(base !== undefined && { base }),
        name: offer.name,
        description: description ?? "",
        color: lookColor(look, blocks),
        glow: look.glow === true,
        ...(look.block !== undefined && { block: look.block }),
        ownLook: ownLook ?? {},
        ...(form.shape !== undefined && { shape: form.shape }),
        ownForm: stored?.form ?? {},
        placement: placementName(form.placement),
      };
    }),
  }));
}

/**
 * The semantics a new project starts with, each with a block from the voxyl default set so a
 * first build looks like something, and a description of what it is for (what an agent or a
 * teammate reads). Names are intent, for any kind of voxel build. Changing a look never
 * touches a cell (principle 3); clearing the block leaves the semantic undecided, drawn in
 * its hint colour (principle 5).
 */
export const STARTER_SEMANTICS: readonly {
  name: string;
  description: string;
  block: string;
  tint: string;
  glow?: boolean;
}[] = [
  {
    name: "Base",
    description: "Foundations and plinths: what the build stands on",
    block: "voxyl:stone_bricks",
    tint: "#8d8f94",
  },
  {
    name: "Wall",
    description: "The main body of walls and the outer shell",
    block: "voxyl:white_concrete",
    tint: "#d9d4c7",
  },
  {
    name: "Floor",
    description: "Floors, decks and walkways",
    block: "voxyl:oak_planks",
    tint: "#9a7b5a",
  },
  {
    name: "Roof",
    description: "Roofs and the tops of things",
    block: "voxyl:gray_concrete",
    tint: "#5b6470",
  },
  {
    name: "Trim",
    description: "Edges, frames, ledges and bands that outline the shape",
    block: "voxyl:quartz_block",
    tint: "#f2f2ef",
  },
  {
    name: "Accent",
    description: "A few standout details in the build's accent colour",
    block: "voxyl:cyan_concrete",
    tint: "#22b8cf",
  },
  {
    name: "Glass",
    description: "Windows and glazing",
    block: "voxyl:glass",
    tint: "#a9d8e8",
  },
  {
    name: "Light",
    description: "Light sources",
    block: "voxyl:glowstone",
    tint: "#ffd36b",
    glow: true,
  },
  {
    name: "Detail",
    description: "Small features: posts, beams, furniture",
    block: "voxyl:oak_log",
    tint: "#6b4f3a",
  },
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
        description: s.description,
        look: { block: s.block, tint: s.tint, ...(s.glow && { glow: true }) },
      },
    });
  });
  return project;
}
