import { FACES } from "./faces.ts";

/** Bytes per quad: x, y, z, face, w, h, then the cell-state id (2 bytes). */
export const QUAD_BYTES = 8;

export interface ChunkMeshInput {
  /** Chunk edge length as a power of two. */
  readonly bits: number;
  /**
   * The chunk's cell-state ids with a one-cell border from its neighbours, as written by
   * World.copyPadded(): (size + 2)³, index (x + 1) + (z + 1) * P + (y + 1) * P * P.
   */
  readonly cells: Uint16Array;
  /**
   * Also report which light bricks (2^lightBrickBits cells a side) the faces read, or null
   * not to. See ChunkMesh.lightBricks.
   */
  readonly lightBrickBits: number | null;
}

export interface ChunkMesh {
  /**
   * QUAD_BYTES per quad: x, y, z (the chunk-local cell the quad starts at), face, w (cells
   * along the face's U axis), h (cells along V), the cell-state id as two bytes (low first).
   * Positions and sizes fit in a byte because chunks are at most 128 cells.
   */
  readonly quads: Uint8Array;
  readonly quadCount: number;
  /**
   * The light bricks the faces read, sorted: every brick holding the empty cell in front of
   * a face or one of the 8 cells around it in the face's plane (the renderer blends those for
   * smooth light and ambient occlusion). A brick at chunk-relative brick coordinates
   * [bx, by, bz], each -1..n where n = size / brick size, is listed as
   * (bx + 1) + (bz + 1) * (n + 2) + (by + 1) * (n + 2)²: bricks of the neighbouring chunks
   * appear too, since faces on the chunk's edge read across it. Empty when not asked for.
   */
  readonly lightBricks: Uint16Array;
}

export function paddedVolume(bits: number): number {
  return ((1 << bits) + 2) ** 3;
}

/**
 * Builds the visible faces of one chunk as greedy-merged quads. A face is visible when the
 * cell beside it is empty; neighbouring visible faces of the same cell state merge into one
 * rectangle. Light is not baked in: the renderer reads it per fragment from its light
 * volume. Every occupied cell hides the faces beside it for now; shaped parts and
 * see-through materials come later.
 */
export function meshChunk(input: ChunkMeshInput): ChunkMesh {
  const { bits, cells, lightBrickBits } = input;
  const size = 1 << bits;
  const P = size + 2;
  const strides = [1, P * P, P] as const; // x, y, z in the padded array
  const area = size * size;
  const maskId = new Uint16Array(area);
  let out = new Uint8Array(QUAD_BYTES * 1024);
  let quadCount = 0;
  const origin = [0, 0, 0];

  // Light bricks read, flagged in a (n + 2)³ grid of chunk-relative bricks.
  const bb = lightBrickBits ?? 0;
  const NB = (size >> bb) + 2;
  const brickStrides = [1, NB * NB, NB] as const;
  const read = lightBrickBits === null ? null : new Uint8Array(NB ** 3);
  /** The shifted brick coordinate (brick + 1) of a padded cell coordinate. */
  const brickOf = (padded: number) => (padded - 1 + (1 << bb)) >> bb;

  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f];
    if (!face) continue;
    const sA = strides[face.axis];
    const sU = strides[face.u];
    const sV = strides[face.v];
    const step = face.sign * sA;
    const bA = brickStrides[face.axis];
    const bU = brickStrides[face.u];
    const bV = brickStrides[face.v];

    for (let d = 0; d < size; d++) {
      let any = false;
      const layer = (d + 1) * sA + sU + sV;
      const frontBrick = brickOf(d + 1 + face.sign) * bA;
      for (let v = 0; v < size; v++) {
        let index = layer + v * sV;
        let m = v * size;
        for (let u = 0; u < size; u++, index += sU, m++) {
          const id = cells[index] ?? 0;
          if (id === 0 || (cells[index + step] ?? 0) !== 0) {
            maskId[m] = 0;
            continue;
          }
          maskId[m] = id;
          any = true;
          if (read) {
            for (let du = 0; du <= 2; du++) {
              const at = frontBrick + brickOf(u + du) * bU;
              for (let dv = 0; dv <= 2; dv++) read[at + brickOf(v + dv) * bV] = 1;
            }
          }
        }
      }
      if (!any) continue;

      for (let v = 0; v < size; v++) {
        let u = 0;
        while (u < size) {
          const m = v * size + u;
          const id = maskId[m] ?? 0;
          if (id === 0) {
            u++;
            continue;
          }
          let w = 1;
          while (u + w < size && maskId[m + w] === id) w++;
          let h = 1;
          grow: while (v + h < size) {
            const row = (v + h) * size + u;
            for (let k = 0; k < w; k++) if (maskId[row + k] !== id) break grow;
            h++;
          }
          for (let dv = 0; dv < h; dv++) {
            maskId.fill(0, (v + dv) * size + u, (v + dv) * size + u + w);
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

  let lightBricks = new Uint16Array(0);
  if (read) {
    let count = 0;
    for (let i = 0; i < read.length; i++) count += read[i] ?? 0;
    lightBricks = new Uint16Array(count);
    for (let i = 0, k = 0; i < read.length; i++) if (read[i]) lightBricks[k++] = i;
  }
  return { quads: out.slice(0, quadCount * QUAD_BYTES), quadCount, lightBricks };
}
