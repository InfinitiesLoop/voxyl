import { axisStrides, FACES } from "./faces.ts";

/** Bytes per quad in ChunkMesh.quads. */
export const QUAD_BYTES = 8;

export interface ChunkMeshInput {
  /** Chunk edge length as a power of two. */
  readonly bits: number;
  /** The chunk's cell-state ids, in ChunkLayout index order. */
  readonly cells: Uint16Array;
  /**
   * For each face (FACES order), the layer of the neighbouring chunk that touches this one,
   * from extractSlab(). Null when that neighbour is empty.
   */
  readonly neighbors: readonly (Uint16Array | null)[];
}

export interface ChunkMesh {
  /**
   * QUAD_BYTES per quad: x, y, z (the chunk-local cell the quad starts at), face, w (cells
   * along the face's U axis), h (cells along V), then the cell-state id as two bytes, low
   * first. Positions and sizes fit in a byte because chunks are at most 64 cells.
   */
  readonly quads: Uint8Array;
  readonly quadCount: number;
}

/**
 * Builds the visible faces of one chunk as greedy-merged quads: a face is visible when the
 * cell beside it is empty, and neighbouring visible faces with the same cell state merge
 * into one rectangle. Every occupied cell is treated as an opaque full cube for now; shaped
 * parts and transparent materials come later.
 */
export function meshChunk(input: ChunkMeshInput): ChunkMesh {
  const { bits, cells, neighbors } = input;
  const size = 1 << bits;
  const strides = axisStrides(size);
  const mask = new Uint16Array(size * size);
  let out = new Uint8Array(QUAD_BYTES * 1024);
  let quadCount = 0;
  const origin = [0, 0, 0];

  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f];
    if (!face) continue;
    const sA = strides[face.axis];
    const sU = strides[face.u];
    const sV = strides[face.v];
    const slab = neighbors[f] ?? null;

    for (let d = 0; d < size; d++) {
      const beyond = d + face.sign;
      const outside = beyond < 0 || beyond >= size;
      const neighborStep = face.sign * sA;
      let any = false;

      for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) {
          const index = d * sA + u * sU + v * sV;
          const id = cells[index] ?? 0;
          let visible = 0;
          if (id !== 0) {
            const next = outside
              ? slab
                ? (slab[u * size + v] ?? 0)
                : 0
              : (cells[index + neighborStep] ?? 0);
            if (next === 0) {
              visible = id;
              any = true;
            }
          }
          mask[v * size + u] = visible;
        }
      }
      if (!any) continue;

      for (let v = 0; v < size; v++) {
        let u = 0;
        while (u < size) {
          const row = v * size;
          const id = mask[row + u] ?? 0;
          if (id === 0) {
            u++;
            continue;
          }
          let w = 1;
          while (u + w < size && mask[row + u + w] === id) w++;
          let h = 1;
          grow: while (v + h < size) {
            const nextRow = (v + h) * size;
            for (let k = 0; k < w; k++) {
              if (mask[nextRow + u + k] !== id) break grow;
            }
            h++;
          }
          for (let dv = 0; dv < h; dv++) {
            mask.fill(0, (v + dv) * size + u, (v + dv) * size + u + w);
          }

          if ((quadCount + 1) * QUAD_BYTES > out.length) {
            const grown = new Uint8Array(out.length * 2);
            grown.set(out);
            out = grown;
          }
          origin[face.axis] = d;
          origin[face.u] = u;
          origin[face.v] = v;
          const o = quadCount * QUAD_BYTES;
          out[o] = origin[0] ?? 0;
          out[o + 1] = origin[1] ?? 0;
          out[o + 2] = origin[2] ?? 0;
          out[o + 3] = f;
          out[o + 4] = w;
          out[o + 5] = h;
          out[o + 6] = id & 0xff;
          out[o + 7] = id >> 8;
          quadCount++;
          u += w;
        }
      }
    }
  }
  return { quads: out.slice(0, quadCount * QUAD_BYTES), quadCount };
}

/**
 * The layer of a neighbouring chunk that touches this chunk across `face`, laid out as the
 * mesher reads it: index u * size + v, in that face's (U, V) axes. Returns null when the
 * layer is empty, so empty slabs cost nothing to send to a worker.
 */
export function extractSlab(
  neighborCells: Uint16Array,
  bits: number,
  face: number,
): Uint16Array | null {
  const axes = FACES[face];
  if (!axes) throw new RangeError(`No face ${face}`);
  const size = 1 << bits;
  const strides = axisStrides(size);
  const sA = strides[axes.axis];
  const sU = strides[axes.u];
  const sV = strides[axes.v];
  // Crossing +X leads into the neighbour's x = 0 layer; crossing -X into its last layer.
  const layer = axes.sign > 0 ? 0 : size - 1;
  const slab = new Uint16Array(size * size);
  let any = false;
  for (let u = 0; u < size; u++) {
    for (let v = 0; v < size; v++) {
      const id = neighborCells[layer * sA + u * sU + v * sV] ?? 0;
      slab[u * size + v] = id;
      if (id !== 0) any = true;
    }
  }
  return any ? slab : null;
}
