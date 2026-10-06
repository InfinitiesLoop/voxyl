// Messages between the main thread and the world worker, which owns the World, the light
// engine and mesh scheduling (a WorldSession). Mesh workers take jobs from the world worker
// over MessagePorts and hand results back to it; it forwards them here in one ordered stream
// with the light, so the main thread applies everything in the order it happened.
//
// Commands carry a sequence number. The worker replies to each, and posts "idle" with the
// last sequence number once all the work those commands caused has been sent. Everything it
// sends about a world is tagged with the world's id, so messages about a world that has since
// been replaced are dropped.

import type { StateShape } from "@voxyl/mesher";
import type { LightingMode, LightLayoutUpdate, MeshJob, ProjectEntry } from "@voxyl/session";
import type { SliceAxis } from "../views/plane.ts";
import type { WorldInfo, WorldSource } from "../worlds.ts";

/** The most cells one slice request may ask for. */
export const MAX_SLICE_CELLS = 1 << 20;

export type Vec3 = readonly [number, number, number];

export interface RayHit {
  readonly cell: Vec3;
  readonly normal: Vec3;
  readonly id: number;
  readonly semantic: string;
}

/** Commands, each answered with a reply of the matching type. */
export type Command =
  /** Generates a sample (with a city theme) or opens a saved project. */
  | { type: "load"; world: number; source: WorldSource; chunkSize: number; theme: number }
  /** Saves the open project (a sample becomes a saved project); later changes autosave. */
  | { type: "save" }
  /** Saved projects, most recent first. */
  | { type: "projects" }
  | { type: "deleteProject"; id: string }
  /** Stores a bundle file as a saved project. */
  | { type: "importProject"; bytes: Uint8Array }
  /** A saved project as a bundle file. */
  | { type: "exportProject"; id: string }
  | { type: "lighting"; mode: LightingMode }
  /** Re-skins a city with another city theme (a palette_sync): looks only. */
  | { type: "theme"; theme: number }
  /** The id of the whole-block state of a semantic, by name (added if new). */
  | { type: "intern"; semantic: string }
  | { type: "setId"; at: Vec3; id: number }
  | { type: "fillBox"; from: Vec3; to: Vec3; id: number }
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
  /** What a cell holds, in words, or null if it is empty. */
  | { type: "cell"; at: Vec3 }
  /** Raycast and edit what it hits: erase it, or place `id` against it. */
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
  /** applied is false for a project without the city theme. */
  theme: { applied: boolean; relit: boolean };
  save: ProjectEntry;
  projects: ProjectEntry[];
  deleteProject: null;
  importProject: ProjectEntry;
  exportProject: Uint8Array;
  intern: number;
  setId: boolean;
  fillBox: number;
  raycast: RayHit | null;
  slice: { ids: Uint16Array; below: Uint16Array };
  cell: string | null;
  rayEdit: boolean;
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
    }
  /** Writes for the light volume (see LightLayout), applied whole. */
  | { type: "light"; world: number; update: LightLayoutUpdate }
  /** Every cell state's look (StateLooks.colors), sent when states or looks change. */
  | { type: "looks"; world: number; colors: Uint8Array }
  | { type: "idle"; world: number; seq: number }
  | { type: "stats"; world: number; stats: WorldStats };

/**
 * What the world worker sends a mesh worker, tagged with its world: a job, or the shapes of
 * cell states from id `from` on (sent before any job that uses them).
 */
export type MeshRequest =
  | { readonly world: number; readonly job: MeshJob }
  | { readonly world: number; readonly from: number; readonly shapes: readonly StateShape[] };

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
  /** Time spent meshing. */
  readonly ms: number;
}
