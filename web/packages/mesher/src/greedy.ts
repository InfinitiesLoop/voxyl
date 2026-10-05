import { FACES } from "./faces.ts";
import {
  canonicalAxes,
  covers,
  RECT_STRIDE,
  type ShapeTable,
  TRI_SCALE,
  TRI_STRIDE,
} from "./parts.ts";

/** Uint16s per quad: x, y, z (eighths of a cell), face, w, h (eighths), cell-state id, unused. */
export const QUAD_WORDS = 8;
export const QUAD_BYTES = QUAD_WORDS * 2;
/** Uint16s per triangle: three corners of x, y, z (1/TRI_SCALE of a cell), plus the id after the first. */
export const TRI_WORDS = 12;
export const TRI_BYTES = TRI_WORDS * 2;

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
   * QUAD_WORDS per quad: the corner the quad starts at (x, y, z in eighths of a cell, chunk
   * local, on the face's plane), the face, its size along the face's U and V axes in eighths,
   * and the cell-state id it is coloured by.
   */
  readonly quads: Uint16Array;
  readonly quadCount: number;
  /**
   * TRI_WORDS per triangle, for shaped parts that aren't axis-aligned: corners (x, y, z) in
   * 1/TRI_SCALE of a cell, chunk local, wound counter-clockwise seen from outside; word 3 is
   * the cell-state id.
   */
  readonly tris: Uint16Array;
  readonly triCount: number;
  /**
   * The light bricks the faces read, sorted: every brick holding the cell in front of a face
   * or one of the 8 cells around it in the face's plane (the renderer blends those for smooth
   * light and ambient occlusion); for a shaped cell, every brick within one cell of it. A
   * brick at chunk-relative brick coordinates [bx, by, bz], each -1..n where n = size / brick
   * size, is listed as (bx + 1) + (bz + 1) * (n + 2) + (by + 1) * (n + 2)²: bricks of the
   * neighbouring chunks appear too, since faces on the chunk's edge read across it. Empty
   * when not asked for.
   */
  readonly lightBricks: Uint16Array;
}

export function paddedVolume(bits: number): number {
  return ((1 << bits) + 2) ** 3;
}

/** A growable Uint16 output buffer. */
class Words {
  data: Uint16Array;
  length = 0;
  constructor(initial: number) {
    this.data = new Uint16Array(initial);
  }
  reserve(n: number): Uint16Array {
    if (this.length + n > this.data.length) {
      const grown = new Uint16Array(Math.max(this.data.length * 2, this.length + n));
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    return this.data;
  }
}

/**
 * Builds the visible faces of one chunk. Whole cubes become greedy-merged quads: a face shows
 * unless the cell beside it covers that whole side, and neighbouring faces of the same state
 * merge into one rectangle. Shaped parts (see ShapeTable) add their own faces: axis-aligned
 * ones as quads merged across cells where they line up, slopes and the like as triangles.
 * Light is not baked in: the renderer reads it per fragment from its light volume.
 */
export function meshChunk(input: ChunkMeshInput, shapes: ShapeTable): ChunkMesh {
  const { bits, cells, lightBrickBits } = input;
  const size = 1 << bits;
  const P = size + 2;
  const strides = [1, P * P, P] as const; // x, y, z in the padded array
  const area = size * size;
  const maskId = new Uint16Array(area);
  const quads = new Words(QUAD_WORDS * 1024);
  const { cube, full, shaped } = shapes;
  const origin = [0, 0, 0];

  // Shaped cells, border included. If there are none, every occupied cell is a whole cube
  // and the cheap test (is the neighbour empty?) decides every face.
  const shapedCells: number[] = [];
  // Near shaped cells, each cell's sides covered (bits 0-5, FACES order) and whether it is a
  // whole cube (bit 6), looked up once here rather than in every pass below.
  let kinds: Uint8Array | null = null;
  if (shapes.shapedCount > 0) {
    for (let i = 0; i < cells.length; i++) {
      if (shaped[cells[i] ?? 0] === 0) continue;
      if (!kinds) {
        kinds = new Uint8Array(cells.length);
        for (let k = 0; k < cells.length; k++) {
          const id = cells[k] ?? 0;
          kinds[k] = (full[id] ?? 0) | ((cube[id] ?? 0) << 6);
        }
      }
      const x = i % P;
      const z = Math.floor(i / P) % P;
      const y = Math.floor(i / (P * P));
      if (x > 0 && x <= size && y > 0 && y <= size && z > 0 && z <= size) shapedCells.push(i);
    }
  }

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
    const hides = 1 << (f ^ 1); // the neighbour's side facing this face
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
          if (id === 0) {
            maskId[m] = 0;
            continue;
          }
          // Near shaped cells: shaped cells draw no cube faces, and a neighbour hides a face
          // only if it covers that whole side.
          if (
            kinds
              ? ((kinds[index] ?? 0) & 64) === 0 || ((kinds[index + step] ?? 0) & hides) !== 0
              : (cells[index + step] ?? 0) !== 0
          ) {
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
          origin[face.axis] = (face.sign > 0 ? d + 1 : d) * 8;
          origin[face.u] = u * 8;
          origin[face.v] = v * 8;
          const out = quads.reserve(QUAD_WORDS);
          const o = quads.length;
          out[o] = origin[0] ?? 0;
          out[o + 1] = origin[1] ?? 0;
          out[o + 2] = origin[2] ?? 0;
          out[o + 3] = f;
          out[o + 4] = w * 8;
          out[o + 5] = h * 8;
          out[o + 6] = id;
          out[o + 7] = 0;
          quads.length += QUAD_WORDS;
          u += w;
        }
      }
    }
  }

  const tris = meshParts(cells, shapedCells, size, shapes, quads, read, lightBrickBits ?? 0);

  let lightBricks = new Uint16Array(0);
  if (read) {
    let count = 0;
    for (let i = 0; i < read.length; i++) count += read[i] ?? 0;
    lightBricks = new Uint16Array(count);
    for (let i = 0, k = 0; i < read.length; i++) if (read[i]) lightBricks[k++] = i;
  }
  return {
    quads: quads.data.slice(0, quads.length),
    quadCount: quads.length / QUAD_WORDS,
    tris: tris.data.slice(0, tris.length),
    triCount: tris.length / TRI_WORDS,
    lightBricks,
  };
}

/**
 * Adds the faces of the chunk's shaped cells: rects to `quads` (merged across cells), and
 * returns the triangles. Flags the light bricks each shaped cell reads in `read` (as
 * meshChunk lays it out for `brickBits`), if given.
 */
function meshParts(
  cells: Uint16Array,
  shapedCells: readonly number[],
  size: number,
  shapes: ShapeTable,
  quads: Words,
  read: Uint8Array | null,
  brickBits: number,
): Words {
  const P = size + 2;
  const strides = [1, P * P, P] as const;
  const { cube, geometry } = shapes;
  const tris = new Words(0);
  if (shapedCells.length === 0) return tris;
  const B = 1 << brickBits;
  const NB = (size >> brickBits) + 2;
  // Visible rects by plane: key (face * 1025 + plane) * 65536 + colour -> u0, v0, u1, v1, ...
  const planes = new Map<number, number[]>();
  const uLow = [0, 1, 2, 3, 4, 5].map((f) => canonicalAxes(f).uLow);
  const cell = [0, 0, 0];

  for (const index of shapedCells) {
    const g = geometry[cells[index] ?? 0];
    if (!g) continue;
    const x = (index % P) - 1;
    const z = (Math.floor(index / P) % P) - 1;
    const y = Math.floor(index / (P * P)) - 1;
    if (read) {
      // A shaped cell's faces read light anywhere within one cell of it.
      const b0 = [x, y, z].map((c) => (c + B - 1) >> brickBits); // brick + 1 of c - 1
      const b1 = [x, y, z].map((c) => (c + B + 1) >> brickBits); // brick + 1 of c + 1
      for (let by = b0[1] ?? 0; by <= (b1[1] ?? 0); by++) {
        for (let bz = b0[2] ?? 0; bz <= (b1[2] ?? 0); bz++) {
          for (let bx = b0[0] ?? 0; bx <= (b1[0] ?? 0); bx++) read[bx + bz * NB + by * NB * NB] = 1;
        }
      }
    }
    cell[0] = x;
    cell[1] = y;
    cell[2] = z;

    const r = g.rects;
    for (let i = 0; i < r.length; i += RECT_STRIDE) {
      const f = r[i] ?? 0;
      const face = FACES[f];
      if (!face) continue;
      const plane = r[i + 1] ?? 0;
      const u0 = r[i + 2] ?? 0;
      const v0 = r[i + 3] ?? 0;
      const u1 = r[i + 4] ?? 0;
      const v1 = r[i + 5] ?? 0;
      if (plane === (face.sign > 0 ? 8 : 0)) {
        const n = cells[index + face.sign * strides[face.axis]] ?? 0;
        if (cube[n]) continue;
        const ng = geometry[n];
        if (ng) {
          const hidden = uLow[f]
            ? covers(ng.cover, f ^ 1, u0, v0, u1, v1)
            : covers(ng.cover, f ^ 1, v0, u0, v1, u1);
          if (hidden) continue;
        }
      }
      const key = (f * 1025 + (cell[face.axis] ?? 0) * 8 + plane) * 65536 + (r[i + 6] ?? 0);
      let list = planes.get(key);
      if (!list) {
        list = [];
        planes.set(key, list);
      }
      const cu = (cell[face.u] ?? 0) * 8;
      const cv = (cell[face.v] ?? 0) * 8;
      list.push(cu + u0, cv + v0, cu + u1, cv + v1);
    }

    const t = g.tris;
    for (let i = 0; i < t.length; i += TRI_STRIDE) {
      const b = t[i + 10] ?? -1;
      if (b >= 0) {
        const face = FACES[b];
        if (!face) continue;
        const n = cells[index + face.sign * strides[face.axis]] ?? 0;
        if (cube[n]) continue;
        const ng = geometry[n];
        if (ng && ((t[i + 11] ?? 0) | (t[i + 12] ?? 0)) !== 0) {
          // Hidden if the neighbour covers every eighth of the side this triangle does.
          const lo = t[i + 11] ?? 0;
          const hi = t[i + 12] ?? 0;
          const side = (b ^ 1) * 2;
          if (
            ((ng.cover[side] ?? 0) & lo) >>> 0 === lo &&
            ((ng.cover[side + 1] ?? 0) & hi) >>> 0 === hi
          ) {
            continue;
          }
        }
      }
      const out = tris.reserve(TRI_WORDS);
      const o = tris.length;
      for (let k = 0; k < 3; k++) {
        out[o + k * 4] = x * TRI_SCALE + (t[i + k * 3] ?? 0);
        out[o + k * 4 + 1] = y * TRI_SCALE + (t[i + k * 3 + 1] ?? 0);
        out[o + k * 4 + 2] = z * TRI_SCALE + (t[i + k * 3 + 2] ?? 0);
        out[o + k * 4 + 3] = 0;
      }
      out[o + 3] = t[i + 9] ?? 0;
      tris.length += TRI_WORDS;
    }
  }

  for (const [key, list] of planes) {
    const color = key % 65536;
    const rest = (key - color) / 65536;
    const f = Math.floor(rest / 1025);
    const plane = rest % 1025;
    const face = FACES[f];
    if (!face) continue;
    for (const { u0, v0, u1, v1 } of mergeRects(list)) {
      const out = quads.reserve(QUAD_WORDS);
      const o = quads.length;
      const at = [0, 0, 0];
      at[face.axis] = plane;
      at[face.u] = u0;
      at[face.v] = v0;
      out[o] = at[0] ?? 0;
      out[o + 1] = at[1] ?? 0;
      out[o + 2] = at[2] ?? 0;
      out[o + 3] = f;
      out[o + 4] = u1 - u0;
      out[o + 5] = v1 - v0;
      out[o + 6] = color;
      out[o + 7] = 0;
      quads.length += QUAD_WORDS;
    }
  }
  return tris;
}

interface Rect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Merges rectangles (u0, v0, u1, v1, ... in one plane) that share an edge exactly: first
 * along U, rows with the same V span, then along V, columns with the same U span.
 */
function mergeRects(flat: readonly number[]): Rect[] {
  const rects: Rect[] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    rects.push({
      u0: flat[i] ?? 0,
      v0: flat[i + 1] ?? 0,
      u1: flat[i + 2] ?? 0,
      v1: flat[i + 3] ?? 0,
    });
  }
  if (rects.length < 2) return rects;
  rects.sort((a, b) => a.v0 - b.v0 || a.v1 - b.v1 || a.u0 - b.u0);
  const rows: Rect[] = [];
  for (const r of rects) {
    const last = rows[rows.length - 1];
    if (last && last.v0 === r.v0 && last.v1 === r.v1 && last.u1 === r.u0) last.u1 = r.u1;
    else rows.push(r);
  }
  rows.sort((a, b) => a.u0 - b.u0 || a.u1 - b.u1 || a.v0 - b.v0);
  const out: Rect[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.u0 === r.u0 && last.u1 === r.u1 && last.v1 === r.v0) last.v1 = r.v1;
    else out.push(r);
  }
  return out;
}
