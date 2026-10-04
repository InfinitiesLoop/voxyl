// Messages between the ChunkRenderer and its mesh workers. Buffers are transferred, not
// copied: the renderer sends padded snapshots of a chunk, the worker sends back packed quads.

export interface MeshJob {
  readonly jobId: number;
  readonly key: number;
  readonly bits: number;
  /** World.copyPadded() output. */
  readonly cells: Uint16Array;
  /** LightEngine.copyPadded() output to bake into the quads, or null for plain quads. */
  readonly light: Uint16Array | null;
  /** Per cell-state id, nonzero if it blocks light; null for plain quads. */
  readonly opaque: Uint8Array | null;
}

export interface MeshResult {
  readonly jobId: number;
  readonly key: number;
  readonly quads: Uint8Array;
  readonly quadCount: number;
  /** QUAD_BYTES, or LIT_QUAD_BYTES with baked light. */
  readonly quadBytes: number;
  /** Time spent meshing in the worker. */
  readonly ms: number;
}
