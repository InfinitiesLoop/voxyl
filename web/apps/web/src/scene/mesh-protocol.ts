// Messages between the ChunkRenderer and its mesh workers. Buffers are transferred, not
// copied: the renderer sends a snapshot of the chunk, the worker sends back packed quads.

export interface MeshJob {
  readonly jobId: number;
  readonly key: number;
  readonly bits: number;
  readonly cells: Uint16Array;
  readonly neighbors: (Uint16Array | null)[];
}

export interface MeshResult {
  readonly jobId: number;
  readonly key: number;
  readonly quads: Uint8Array;
  readonly quadCount: number;
  /** Time spent meshing in the worker. */
  readonly ms: number;
}
