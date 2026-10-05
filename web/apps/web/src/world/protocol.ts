// Messages between the main thread and the world worker, which owns the World, the light
// engine and mesh scheduling (a WorldSession). Mesh workers take jobs from the world worker
// over MessagePorts and hand results back to it; it forwards them here in one ordered stream
// with the light, so the main thread applies everything in the order it happened.
//
// Commands carry a sequence number. The worker replies to each, and posts "idle" with the
// last sequence number once all the work those commands caused has been sent. Everything it
// sends about a world is tagged with the world's id, so messages about a world that has since
// been replaced are dropped.

import type { CellStateInput } from "@voxyl/core";
import type { StateShape } from "@voxyl/mesher";
import type { LightingMode, LightLayoutUpdate, MeshJob } from "@voxyl/session";
import type { Palette } from "../palettes.ts";
import type { WorldInfo, WorldKind } from "../worlds.ts";

export type Vec3 = readonly [number, number, number];

export interface RayHit {
  readonly cell: Vec3;
  readonly normal: Vec3;
  readonly id: number;
  readonly semantic: string;
}

/** Commands, each answered with a reply of the matching type. */
export type Command =
  | { type: "load"; world: number; kind: WorldKind; chunkSize: number }
  | { type: "lighting"; mode: LightingMode }
  | { type: "palette"; palette: Palette }
  | { type: "intern"; state: CellStateInput }
  | { type: "setId"; at: Vec3; id: number }
  | { type: "fillBox"; from: Vec3; to: Vec3; id: number }
  | { type: "raycast"; origin: Vec3; dir: Vec3; reach: number }
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
  palette: { relit: boolean };
  intern: number;
  setId: boolean;
  fillBox: number;
  raycast: RayHit | null;
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
  /** The semantic of every cell-state id (index 0 is empty), sent when new states appear. */
  | { type: "states"; world: number; semantics: string[] }
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
