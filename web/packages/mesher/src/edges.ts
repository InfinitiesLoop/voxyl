// Feature edges of a chunk, for the line-drawing render modes (outline, x-ray, wire): the
// cell edges where the surface turns (a corner or a crease) or where two different cell
// states meet on a flat surface. Every occupied cell counts as a whole cube here; shaped
// parts and block models draw their outline as the cell's.

/** Uint16s per edge: x, y, z of its start (cell corners, chunk local), axis, length, state id. */
export const EDGE_WORDS = 6;

export interface ChunkEdges {
  readonly edges: Uint16Array;
  readonly edgeCount: number;
}

/**
 * The feature edges of one chunk from its padded cells (World.copyPadded: (size + 2)³, index
 * (x + 1) + (z + 1) * P + (y + 1) * P * P). An edge runs along one axis; around it lie four
 * cells. It is drawn when one or three of them are occupied (a corner), when two diagonal
 * ones are (a crease), or when two side by side are but hold different states (a seam on a
 * flat face). Runs along the axis with the same state merge into one edge. Edges on the
 * chunk's faces are drawn by both chunks that share them, so neither may be missing.
 */
export function chunkEdges(bits: number, cells: Uint16Array): ChunkEdges {
  const size = 1 << bits;
  const P = size + 2;
  // Strides of x, y and z in the padded array, and where cell (0, 0, 0) is.
  const stride = [1, P * P, P];
  const origin = 1 + P + P * P;
  const out: number[] = [];
  // For edges along axis a, the other two axes are b and c.
  const AXES = [
    [0, 1, 2],
    [1, 0, 2],
    [2, 0, 1],
  ] as const;
  for (const [a, b, c] of AXES) {
    const sa = stride[a] ?? 0;
    const sb = stride[b] ?? 0;
    const sc = stride[c] ?? 0;
    for (let j = 0; j <= size; j++)
      for (let k = 0; k <= size; k++) {
        // Cell (i, j - 1, k - 1) along a, b, c: the first of the four around the edge.
        let index = origin + (j - 1) * sb + (k - 1) * sc;
        let runStart = -1;
        let runId = 0;
        for (let i = 0; i <= size; i++, index += sa) {
          const id =
            i === size
              ? 0
              : edgeAt(
                  cells[index] ?? 0,
                  cells[index + sb] ?? 0,
                  cells[index + sc] ?? 0,
                  cells[index + sb + sc] ?? 0,
                );
          if (runStart >= 0 && id !== runId) {
            const start = [0, 0, 0];
            start[a] = runStart;
            start[b] = j;
            start[c] = k;
            out.push(start[0] ?? 0, start[1] ?? 0, start[2] ?? 0, a, i - runStart, runId);
            runStart = -1;
          }
          if (id !== 0 && runStart < 0) {
            runStart = i;
            runId = id;
          }
        }
      }
  }
  return { edges: Uint16Array.from(out), edgeCount: out.length / EDGE_WORDS };
}

/**
 * The state an edge between four cells is drawn in (the first occupied one), or 0 if it is
 * no feature edge. s00 and s11 are diagonal, as are s10 and s01.
 */
export function edgeAt(s00: number, s10: number, s01: number, s11: number): number {
  const n = (s00 ? 1 : 0) + (s10 ? 1 : 0) + (s01 ? 1 : 0) + (s11 ? 1 : 0);
  const first = s00 || s10 || s01 || s11;
  if (n === 1 || n === 3) return first;
  if (n !== 2) return 0;
  // Diagonal: a crease. Side by side: a flat face, drawn only where the states differ.
  if ((s00 && s11) || (s10 && s01)) return first;
  const [x, y] =
    s00 && s10 ? [s00, s10] : s00 && s01 ? [s00, s01] : s11 && s10 ? [s11, s10] : [s11, s01];
  return x !== y ? first : 0;
}
