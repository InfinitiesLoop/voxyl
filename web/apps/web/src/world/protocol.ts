// Messages between the main thread and the world worker, which owns the World, the light
// engine and mesh scheduling (a WorldSession). Mesh workers take jobs from the world worker
// over MessagePorts and hand results back to it; it forwards them here in one ordered stream
// with the light, so the main thread applies everything in the order it happened.
//
// Commands carry a sequence number. The worker replies to each, and posts "idle" with the
// last sequence number once all the work those commands caused has been sent. Everything it
// sends about a world is tagged with the world's id, so messages about a world that has since
// been replaced are dropped.

import type { Form, Look, PaletteId, Region, SemanticArg, SharedPalette } from "@voxyl/core";
import type { ModelShape, StateShape } from "@voxyl/mesher";
import type {
  LightingMode,
  LightLayoutUpdate,
  MeshJob,
  ProjectEntry,
  StoredPalette,
} from "@voxyl/session";
import type { SliceAxis } from "../views/plane.ts";
import type { WorldInfo, WorldSource } from "../worlds.ts";
import type { Aim, HistoryState, PaletteInfo, PartGhost } from "./editing.ts";
import type { BuildTool } from "./tools.ts";

/** The most cells one slice request may ask for. */
export const MAX_SLICE_CELLS = 1 << 20;

export type Vec3 = readonly [number, number, number];

export interface RayHit {
  readonly cell: Vec3;
  readonly normal: Vec3;
  readonly id: number;
  /** The semantic of the cell hit (its block's, or its first part's), and its name. */
  readonly semanticId: number;
  readonly semantic: string;
}

/** A ray from the camera, for aiming: where it starts, which way, and how far it reaches. */
/** A multi-block tool, its brush, and where the camera is (Build to me builds toward it). */
export interface ToolArgs {
  readonly tool: BuildTool;
  readonly brush: number;
  readonly camera: Vec3;
}

/** A shaped semantic in hand: the part it would place at the aim (see partGhost). */
export interface PartArgs {
  readonly semantic: SemanticArg;
  /** The modifier that puts the part on the far side of the cell. */
  readonly opposite: boolean;
}

/**
 * An aim, the cells (x, y, z, ...) the tool in hand would build there, if any, the part that
 * would be placed (the ghost), and the shape and slot of the part the ray met.
 */
export type AimView = Aim & {
  readonly preview: Int32Array | null;
  readonly ghost: PartGhost | null;
  readonly aimed: { readonly shape: string; readonly slot: number } | null;
};

/** At most this many cells are previewed (the click still builds them all). */
export const MAX_PREVIEW_CELLS = 8192;

export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3;
  readonly reach: number;
}

/** Commands, each answered with a reply of the matching type. */
export type Command =
  /** Generates a sample (with a city theme) or opens a saved project. */
  | { type: "load"; world: number; source: WorldSource; chunkSize: number; theme: number }
  /** Saves the open project (a sample becomes a saved project); later changes autosave. */
  | { type: "save" }
  /** Saved projects, most recent first. */
  | { type: "projects" }
  /** Creates and saves a new, empty project with the starter semantics. */
  | { type: "createProject"; name: string }
  /** Renames the open project (a settings command, so it undoes). */
  | { type: "rename"; name: string }
  /** Adds a semantic to a palette, optionally with a description and a look. */
  | {
      type: "addSemantic";
      palette: PaletteId;
      name: string;
      description?: string;
      look?: Look;
      form?: Form;
    }
  /** Renames a semantic and sets its description and look, in one step. */
  | {
      type: "editSemantic";
      semantic: SemanticArg;
      name: string;
      description: string;
      look: Look | null;
      form?: Form | null;
    }
  /** Renames a semantic, deriving it first when the palette only offers it. */
  | { type: "renameSemantic"; semantic: SemanticArg; name: string }
  /**
   * Sets the look a semantic stores itself. Null drops it, so a derived semantic inherits
   * its base's look again.
   */
  | { type: "setLook"; semantic: SemanticArg; look: Look | null }
  /** Adds a palette, optionally extending another. */
  | { type: "addPalette"; name: string; extends?: PaletteId }
  | { type: "renamePalette"; palette: PaletteId; name: string }
  /** Blocks from the libraries, for the palette drawer's picker. */
  | { type: "findBlocks"; query: string; library?: string; limit?: number; offset?: number }
  | { type: "deleteProject"; id: string }
  /** Stores a bundle file as a saved project. */
  | { type: "importProject"; bytes: Uint8Array }
  /** A saved project as a bundle file. */
  | { type: "exportProject"; id: string }
  | { type: "lighting"; mode: LightingMode }
  /** Block libraries stored in this browser (imported ones; the default set is built in). */
  | { type: "libraries" }
  /** Imports a Minecraft client jar as the "minecraft" library, replacing any before. */
  | { type: "importJar"; bytes: Uint8Array }
  | { type: "deleteLibrary"; id: string }
  /** Re-skins a city with another city theme (a palette_sync): looks only. */
  | { type: "theme"; theme: number }
  /** The id of the whole-block state of a semantic, by name (added if new). */
  | { type: "intern"; semantic: string }
  /** Writes a state into one cell or a box (EMPTY_ID clears), as commands: scripted edits. */
  | { type: "setId"; at: Vec3; id: number }
  | { type: "fillBox"; from: Vec3; to: Vec3; id: number }
  /**
   * Where a ray from the crosshair aims (see editing.ts), and with `tool`, the cells that
   * tool would build there (the preview).
   */
  | ({ type: "aim"; tool?: ToolArgs; part?: PartArgs } & Ray)
  /** Builds with a multi-block tool where the ray aims (see tools.ts). */
  | ({ type: "toolEdit"; semantic: SemanticArg } & ToolArgs & Ray)
  /** Turns the block the ray aims at about the face it hits (Shift: the other way). */
  | ({ type: "rotate"; reverse: boolean } & Ray)
  /** Places a semantic where the ray aims, turned as its placement profile picks. */
  | ({ type: "place"; semantic: SemanticArg; opposite?: boolean } & Ray)
  /** Empties the cell the ray aims at. */
  | ({ type: "erase" } & Ray)
  /** Sets the selection to a region (null clears it). Not an undo step. */
  | { type: "select"; where: Region | null }
  /** Fills the selection with a semantic, empty cells included. */
  | { type: "fillSelection"; semantic: SemanticArg; look: Vec3 }
  /** Empties the selection. */
  | { type: "clearSelection" }
  /** Turns occupied cells in the selection into whole blocks of a semantic. */
  | { type: "replaceSelection"; semantic: SemanticArg; look: Vec3 }
  /** Switches one semantic for another in the selection, keeping geometry. */
  | { type: "resemanticSelection"; from: SemanticArg; to: SemanticArg }
  /** Undoes the latest step, or redoes the latest undone one. */
  | { type: "undo" }
  | { type: "redo" }
  | { type: "raycast"; origin: Vec3; dir: Vec3; reach: number }
  /**
   * The state ids of a rectangle of a slice (see views/plane.ts), and of the layer just below
   * or behind it (depth - 1), row by row along u. At most MAX_SLICE_CELLS.
   */
  | {
      type: "slice";
      axis: SliceAxis;
      depth: number;
      u0: number;
      v0: number;
      width: number;
      height: number;
    }
  /** The user's shared palettes, most recent first, with a strip of colours each. */
  | { type: "sharedPalettes" }
  /** One shared palette, whole. */
  | { type: "sharedPalette"; key: string }
  /** Stores a shared palette (new, or over the same key: the version goes up if it changed). */
  | { type: "saveSharedPalette"; palette: Omit<SharedPalette, "version"> }
  | { type: "deleteSharedPalette"; key: string }
  /** Shares a palette of the open project as a new shared palette. Replies with its key. */
  | { type: "sharePalette"; palette: PaletteId }
  /** Brings a shared palette into the open project as a linked copy, or re-syncs it. */
  | { type: "linkPalette"; key: string }
  /** A 2D stroke: a semantic into cells (x, y, z triples), or empties them (null). */
  | {
      type: "paintCells";
      cells: number[];
      semantic: SemanticArg | null;
      face: Vec3;
      look: Vec3;
      label: string;
    }
  /** A 2D fill from plane cell (u, v) across the layer, within the view's window. */
  | {
      type: "fillPlane";
      axis: SliceAxis;
      depth: number;
      u: number;
      v: number;
      window: [number, number, number, number];
      semantic: SemanticArg | null;
      face: Vec3;
      look: Vec3;
    }
  /** A multi-block tool used on a cell and one of its faces (Exchange in the 2D view). */
  | ({ type: "toolAt"; at: Vec3; face: Vec3; semantic: SemanticArg } & Omit<ToolArgs, "camera">)
  /** Turns the block in a cell about one of its faces' axes (R over a 2D view). */
  | { type: "rotateAt"; at: Vec3; face: Vec3; reverse: boolean }
  /** The semantic a cell holds (its first part's, for a cell of parts), or null if empty. */
  | { type: "semanticAt"; at: Vec3 }
  /** Removes a semantic no cell uses. */
  | { type: "removeSemantic"; semantic: SemanticArg }
  /** A block's six faces as 16×16 RGBA (mesher order +X, -X, +Y, -Y, +Z, -Z), for previews. */
  | { type: "blockPreview"; ref: string }
  /**
   * Orthographic icons of these blocks, `size`×`size` RGBA each, concatenated. A missing
   * block is transparent. At most 8, so a bake stays a short pause on the world worker.
   */
  | { type: "bakeIcons"; refs: readonly string[]; size?: number }
  /** Sets what a semantic is for. */
  | { type: "describeSemantic"; semantic: SemanticArg; description: string }
  /** Whether meshes come with feature edges, for the line-drawing render modes. */
  | { type: "edges"; on: boolean }
  /** The project's bounds as cell corners, or null when it is empty. */
  | { type: "bounds" }
  /** What a cell holds, in words, or null if it is empty. */
  | { type: "cell"; at: Vec3 }
  /** Raycast and edit what it hits: erase it, or place state `id` against it (the bench). */
  | {
      type: "rayEdit";
      origin: Vec3;
      dir: Vec3;
      reach: number;
      action: "erase" | "place";
      id: number;
    };

export interface Replies {
  load: WorldInfo;
  lighting: { lightAllMs: number | null };
  libraries: LibraryInfo[];
  importJar: LibraryInfo & { readonly skipped: number; readonly ms: number };
  deleteLibrary: null;
  /** applied is false for a project without the city theme. */
  theme: { applied: boolean; relit: boolean };
  save: ProjectEntry;
  projects: ProjectEntry[];
  createProject: ProjectEntry;
  /** True when the name changed. */
  rename: boolean;
  /** False when there was nothing to do (an empty or unchanged name or look). */
  addSemantic: boolean;
  editSemantic: boolean;
  renameSemantic: boolean;
  setLook: boolean;
  addPalette: boolean;
  renamePalette: boolean;
  findBlocks: BlockSearch;
  deleteProject: null;
  importProject: ProjectEntry;
  exportProject: Uint8Array;
  intern: number;
  setId: boolean;
  fillBox: number;
  aim: AimView | null;
  toolEdit: boolean;
  sharedPalettes: SharedPaletteInfo[];
  sharedPalette: StoredPalette | null;
  saveSharedPalette: StoredPalette;
  deleteSharedPalette: null;
  sharePalette: string;
  linkPalette: boolean;
  describeSemantic: boolean;
  removeSemantic: boolean;
  semanticAt: number | null;
  paintCells: boolean;
  fillPlane: boolean;
  toolAt: boolean;
  rotateAt: boolean;
  blockPreview: BlockPreview | null;
  bakeIcons: { readonly size: number; readonly icons: Uint8Array };
  edges: null;
  bounds: { min: Vec3; max: Vec3 } | null;
  rotate: boolean;
  place: boolean;
  erase: boolean;
  select: { cells: number };
  fillSelection: { cells: number };
  clearSelection: { cells: number };
  replaceSelection: { cells: number };
  resemanticSelection: { switched: number; skipped: number };
  undo: boolean;
  redo: boolean;
  raycast: RayHit | null;
  slice: { ids: Uint16Array; below: Uint16Array };
  cell: string | null;
  rayEdit: boolean;
}

/** A page of blocks for the palette drawer's picker. */
export interface BlockSearch {
  readonly libraries: readonly { readonly id: string; readonly name: string }[];
  /** How many blocks matched; hits is one page of them (from `offset`). */
  readonly matched: number;
  readonly hits: readonly { readonly ref: string; readonly name: string; readonly color: string }[];
  /** 16×16 RGBA per hit, concatenated. A blank icon is all zeros. */
  readonly icons: Uint8Array;
}

/** A stored block library, as the app lists it. */
export interface LibraryInfo {
  readonly id: string;
  readonly name: string;
  readonly blocks: number;
}

export type ToWorld =
  | ({ seq: number } & Command)
  | { type: "camera"; at: Vec3 }
  /** One port per mesh worker, sent once at startup. */
  | { type: "meshPorts"; ports: MessagePort[] };
export interface WorldStats {
  readonly cells: number;
  readonly chunkCount: number;
  /** Chunk cell storage. */
  readonly storageMb: number;
  readonly queued: number;
  readonly inFlight: number;
  /** Worker meshing time per chunk over recent jobs. */
  readonly meshMsAvg: number;
  readonly lightAllMs: number | null;
  /** Light engine memory. */
  readonly lightMb: number;
  /** Light bricks kept for the GPU, and chunk tables pointing at them. */
  readonly lightBricks: number;
  readonly lightTables: number;
  /** Time to copy one brick of light for sending, in microseconds. */
  readonly lightCopyUs: number;
}

export type FromWorld =
  | { type: "reply"; seq: number; value: unknown }
  | { type: "error"; seq: number; message: string }
  | {
      type: "mesh";
      world: number;
      key: number;
      quads: Uint16Array;
      quadCount: number;
      tris: Uint16Array;
      triCount: number;
      /** Feature edges (EDGE_WORDS each), or none when the session isn't finding them. */
      edges: Uint16Array;
    }
  /** Writes for the light volume (see LightLayout), applied whole. */
  | { type: "light"; world: number; update: LightLayoutUpdate }
  /** Every cell state's look, sent when states or looks change. */
  | ({ type: "looks"; world: number } & LooksUpdate)
  | { type: "idle"; world: number; seq: number }
  /** Every palette and what it can place, sent when the registry or the libraries change. */
  | { type: "palettes"; world: number; palettes: PaletteInfo[] }
  /** The selection and what it holds, sent when either changes. */
  | { type: "selection"; world: number; view: SelectionView }
  /** What undo and redo would do, plus the name and grid, sent when any of them change. */
  | ({
      type: "history";
      world: number;
      name: string;
      grid: readonly [number, number];
    } & HistoryState)
  | { type: "stats"; world: number; stats: WorldStats };

/** One row of the selection panel: a semantic, or a block several semantics share. */
export interface SelectionRow {
  readonly semantic: number;
  readonly name: string;
  readonly color: string;
  readonly count: number;
  /** A part's shape, or the semantics a shared block merges. */
  readonly detail?: string;
}

/** The selection, as the panel and the outline draw it. `lines` are the silhouette. */
export interface SelectionView {
  /** Cells in the selection, empty ones included. */
  readonly cells: number;
  /** Cells in it that hold something. */
  readonly occupied: number;
  /** The selection is exactly its bounding box. */
  readonly box: boolean;
  /** False when the outline fell back to that box because the selection is too big to trace. */
  readonly exact: boolean;
  readonly bounds: readonly [number, number, number, number, number, number] | null;
  /** Whole blocks, then parts, by semantic. */
  readonly semantics: readonly SelectionRow[];
  /** The same contents by the block each semantic's look maps to. */
  readonly materials: readonly SelectionRow[];
  /** Segment endpoints, xyz xyz, in cell-corner coordinates. */
  readonly lines: Float32Array;
}

/** No selection. */
export const EMPTY_SELECTION: SelectionView = {
  cells: 0,
  occupied: 0,
  box: false,
  exact: true,
  bounds: null,
  semantics: [],
  materials: [],
  lines: new Float32Array(0),
};

/** Cell states' looks for the renderer (see StateLooks and BlockMaterials). */
/** A block's faces for the chooser's turning preview. */
export interface BlockPreview {
  /** 6 × 16 × 16 RGBA; a face's alpha is all 0 where the block has no texture there. */
  readonly faces: Uint8Array;
  /** False for a shape that isn't a whole cube (stairs, slabs): its faces are approximate. */
  readonly cube: boolean;
  readonly color: string;
}

/** A shared palette as Home and the drawer list it. */
export interface SharedPaletteInfo {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly updated: number;
  readonly from: string | null;
  readonly count: number;
  /** Each semantic's colour, in order (the first few make a preview strip). */
  readonly colors: readonly string[];
}

export interface LooksUpdate {
  /** StateLooks.colors. */
  readonly colors: Uint8Array;
  /** StateLooks.intent: each state's semantic's own colour. */
  readonly intent: Uint8Array;
  /** Per state, which way it faces, for the 2D view's arrows (flat-edit.ts stateFacings). */
  readonly facing: Uint8Array;
  /** StateLooks.faces: each state's face materials, and where its model's slots start. */
  readonly faces: Uint32Array;
  /** StateLooks.modelSlots: block models' face materials. */
  readonly modelSlots: Uint16Array;
  /** Every material so far (BlockMaterials.data). */
  readonly materials: Float32Array;
  /** Texture layers added since the last looks, from layer `from` (takeTextures). */
  readonly textures: { readonly from: number; readonly rgba: Uint8Array };
}

/**
 * What the world worker sends a mesh worker, tagged with its world: a job, the shapes of
 * cell states from id `from` on, or what the looks decide about shapes: which states are
 * clear and which draw a block model (all sent before any job that uses them).
 */
export type MeshRequest =
  | { readonly world: number; readonly job: MeshJob }
  | { readonly world: number; readonly from: number; readonly shapes: readonly StateShape[] }
  | {
      readonly world: number;
      readonly clear: Uint8Array;
      readonly models: readonly (ModelShape | null)[];
    };

/** What a mesh worker sends back. */
export interface MeshReply {
  readonly world: number;
  readonly result: MeshResult;
}

export interface MeshResult {
  readonly jobId: number;
  readonly key: number;
  readonly quads: Uint16Array;
  readonly quadCount: number;
  readonly tris: Uint16Array;
  readonly triCount: number;
  /** The light bricks the faces read (ChunkMesh.lightBricks). */
  readonly lightBricks: Uint16Array;
  /** Feature edges (chunkEdges), empty unless the job asked for them. */
  readonly edges: Uint16Array;
  /** Time spent meshing. */
  readonly ms: number;
}
