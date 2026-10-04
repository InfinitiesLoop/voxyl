import { FACES } from "./faces.ts";

/** Bytes per quad without baked light: x, y, z, face, w, h, then the cell-state id (2 bytes). */
export const QUAD_BYTES = 8;
/**
 * Bytes per quad with baked light: the 8 above, then the light at the four corners (sky, red,
 * green, blue, 0..255 each, 16 bytes), then the ambient occlusion factor at each corner
 * (0..255, 4 bytes).
 */
export const LIT_QUAD_BYTES = 28;

/**
 * Ambient occlusion by level, 0 (both sides blocked) to 3 (open). Minecraft averages four
 * samples around a corner and counts a blocking cell as 0.2 instead of 1, so each blocker
 * takes away 0.2.
 */
export const AO_SCALE = [0.4, 0.6, 0.8, 1.0] as const;

export interface ChunkMeshInput {
  /** Chunk edge length as a power of two. */
  readonly bits: number;
  /**
   * The chunk's cell-state ids with a one-cell border from its neighbours, as written by
   * World.copyPadded(): (size + 2)³, index (x + 1) + (z + 1) * P + (y + 1) * P * P.
   */
  readonly cells: Uint16Array;
  /**
   * Packed light per cell in the same padded layout (sky << 12 | r << 8 | g << 4 | b, each
   * 0..15) to bake into the quads, or null for plain quads: lighting off, or light the
   * renderer reads from elsewhere. Without light, faces merge on cell state alone.
   */
  readonly light: Uint16Array | null;
  /** Per cell-state id, nonzero if it blocks light and darkens corners. Needed with light. */
  readonly opaque: Uint8Array | null;
}

export interface ChunkMesh {
  /**
   * quadBytes per quad: x, y, z (the chunk-local cell the quad starts at), face, w (cells
   * along the face's U axis), h (cells along V), the cell-state id as two bytes (low first).
   * Lit quads then carry their four corners in base-quad order (U, V) = (0,0), (1,0), (1,1),
   * (0,1): light as sky, red, green, blue (0..255 for levels 0..15), then the four ambient
   * occlusion factors. Positions and sizes fit in a byte because chunks are at most 128 cells.
   */
  readonly quads: Uint8Array;
  readonly quadCount: number;
  /** QUAD_BYTES, or LIT_QUAD_BYTES when light was baked in. */
  readonly quadBytes: number;
}

/** True if the four corners of mask cell `m` all have the same light and occlusion. */
function uniformAt(maskLight: Uint32Array, maskAo: Uint8Array, m: number): boolean {
  const i = m * 4;
  const c = maskLight[i];
  const ao = maskAo[m] ?? 0;
  return (
    maskLight[i + 1] === c &&
    maskLight[i + 2] === c &&
    maskLight[i + 3] === c &&
    (ao === 0 || ao === 0x55 || ao === 0xaa || ao === 0xff)
  );
}

/** True if mask cells `a` and `b` have the same four corners. */
function sameCorners(maskLight: Uint32Array, maskAo: Uint8Array, a: number, b: number): boolean {
  const i = a * 4;
  const j = b * 4;
  return (
    maskAo[a] === maskAo[b] &&
    maskLight[i] === maskLight[j] &&
    maskLight[i + 1] === maskLight[j + 1] &&
    maskLight[i + 2] === maskLight[j + 2] &&
    maskLight[i + 3] === maskLight[j + 3]
  );
}

export function paddedVolume(bits: number): number {
  return ((1 << bits) + 2) ** 3;
}

/**
 * Builds the visible faces of one chunk as greedy-merged quads. A face is visible when the
 * cell beside it is empty. Neighbouring visible faces merge into one rectangle when they
 * share a cell state and, with baked light, uniform corner light and occlusion; faces with a
 * gradient in one direction merge into strips along the other, and the rest stay one cell.
 * Every occupied cell hides the faces beside it for now; shaped parts and see-through
 * materials come later.
 */
export function meshChunk(input: ChunkMeshInput): ChunkMesh {
  const { bits, cells, light, opaque } = input;
  const size = 1 << bits;
  const P = size + 2;
  const strides = [1, P * P, P] as const; // x, y, z in the padded array
  const area = size * size;
  const lit = light !== null;
  const quadBytes = lit ? LIT_QUAD_BYTES : QUAD_BYTES;
  const maskId = new Uint16Array(area);
  const maskLight = new Uint32Array(lit ? area * 4 : 0);
  const maskAo = new Uint8Array(lit ? area : 0); // four 2-bit occlusion levels per face
  const corner = new Uint32Array(4);
  let out = new Uint8Array(quadBytes * 1024);
  let quadCount = 0;
  const origin = [0, 0, 0];

  const lightAt = (i: number) => light?.[i] ?? 0;
  const opaqueAt = (i: number) => ((opaque?.[cells[i] ?? 0] ?? 0) !== 0 ? 1 : 0);

  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f];
    if (!face) continue;
    const sA = strides[face.axis];
    const sU = strides[face.u];
    const sV = strides[face.v];
    const step = face.sign * sA;

    for (let d = 0; d < size; d++) {
      let any = false;
      const layer = (d + 1) * sA + sU + sV;
      for (let v = 0; v < size; v++) {
        let index = layer + v * sV;
        let m = v * size;
        for (let u = 0; u < size; u++, index += sU, m++) {
          const id = cells[index] ?? 0;
          const front = index + step;
          if (id === 0 || (cells[front] ?? 0) !== 0) {
            maskId[m] = 0;
            continue;
          }
          maskId[m] = id;
          any = true;
          if (!lit) continue;
          let aoLevels = 0;
          for (let k = 0; k < 4; k++) {
            const du = k === 1 || k === 2 ? sU : -sU;
            const dv = k >= 2 ? sV : -sV;
            const side1 = front + du;
            const side2 = front + dv;
            const diag = front + du + dv;
            const o1 = opaqueAt(side1);
            const o2 = opaqueAt(side2);
            const oc = opaqueAt(diag);
            aoLevels |= (o1 && o2 ? 0 : 3 - (o1 + o2 + oc)) << (k * 2);
            // Smooth light: the average of the open cells around this corner, in front of the face.
            let count = 1;
            let packed = lightAt(front);
            let sky = packed >> 12;
            let r = (packed >> 8) & 15;
            let g = (packed >> 4) & 15;
            let b = packed & 15;
            if (!o1) {
              packed = lightAt(side1);
              sky += packed >> 12;
              r += (packed >> 8) & 15;
              g += (packed >> 4) & 15;
              b += packed & 15;
              count++;
            }
            if (!o2) {
              packed = lightAt(side2);
              sky += packed >> 12;
              r += (packed >> 8) & 15;
              g += (packed >> 4) & 15;
              b += packed & 15;
              count++;
            }
            if (!oc && !(o1 && o2)) {
              packed = lightAt(diag);
              sky += packed >> 12;
              r += (packed >> 8) & 15;
              g += (packed >> 4) & 15;
              b += packed & 15;
              count++;
            }
            const scale = 17 / count;
            corner[k] =
              (Math.round(sky * scale) |
                (Math.round(r * scale) << 8) |
                (Math.round(g * scale) << 16) |
                (Math.round(b * scale) << 24)) >>>
              0;
          }
          maskLight.set(corner, m * 4);
          maskAo[m] = aoLevels;
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
          let h = 1;
          if (!lit || uniformAt(maskLight, maskAo, m)) {
            // Unlit, faces merge on state alone; lit, only with faces that match exactly.
            while (
              u + w < size &&
              maskId[m + w] === id &&
              (!lit || sameCorners(maskLight, maskAo, m, m + w))
            ) {
              w++;
            }
            grow: while (v + h < size) {
              const row = (v + h) * size + u;
              for (let k = 0; k < w; k++) {
                if (maskId[row + k] !== id || (lit && !sameCorners(maskLight, maskAo, m, row + k)))
                  break grow;
              }
              h++;
            }
          } else {
            // A gradient in one direction only can still merge into a strip along the other
            // (0fps): faces with identical corners line up into one quad whose corners carry
            // the same gradient, so blending across it is unchanged.
            const i = m * 4;
            const ao = maskAo[m] ?? 0;
            const a0 = ao & 3;
            const a1 = (ao >> 2) & 3;
            const a2 = (ao >> 4) & 3;
            const a3 = (ao >> 6) & 3;
            const flatU =
              maskLight[i] === maskLight[i + 1] && maskLight[i + 3] === maskLight[i + 2];
            const flatV =
              maskLight[i] === maskLight[i + 3] && maskLight[i + 1] === maskLight[i + 2];
            if (flatU && a0 === a1 && a3 === a2) {
              while (
                u + w < size &&
                maskId[m + w] === id &&
                sameCorners(maskLight, maskAo, m, m + w)
              ) {
                w++;
              }
            } else if (flatV && a0 === a3 && a1 === a2) {
              while (
                v + h < size &&
                maskId[m + h * size] === id &&
                sameCorners(maskLight, maskAo, m, m + h * size)
              ) {
                h++;
              }
            }
          }
          for (let dv = 0; dv < h; dv++) {
            maskId.fill(0, (v + dv) * size + u, (v + dv) * size + u + w);
          }

          if ((quadCount + 1) * quadBytes > out.length) {
            const grown = new Uint8Array(out.length * 2);
            grown.set(out);
            out = grown;
          }
          origin[face.axis] = d;
          origin[face.u] = u;
          origin[face.v] = v;
          const o = quadCount * quadBytes;
          out[o] = origin[0] ?? 0;
          out[o + 1] = origin[1] ?? 0;
          out[o + 2] = origin[2] ?? 0;
          out[o + 3] = f;
          out[o + 4] = w;
          out[o + 5] = h;
          out[o + 6] = id & 0xff;
          out[o + 7] = id >> 8;
          if (lit) {
            const ao = maskAo[m] ?? 0;
            for (let k = 0; k < 4; k++) {
              const value = maskLight[m * 4 + k] ?? 0;
              out[o + 8 + k * 4] = value & 0xff;
              out[o + 9 + k * 4] = (value >>> 8) & 0xff;
              out[o + 10 + k * 4] = (value >>> 16) & 0xff;
              out[o + 11 + k * 4] = value >>> 24;
              out[o + 24 + k] = Math.round((AO_SCALE[(ao >> (k * 2)) & 3] ?? 1) * 255);
            }
          }
          quadCount++;
          u += w;
        }
      }
    }
  }
  return { quads: out.slice(0, quadCount * quadBytes), quadCount, quadBytes };
}
