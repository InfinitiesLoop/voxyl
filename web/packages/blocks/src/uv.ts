// Texture coordinates of model faces, as Minecraft computes them (FaceBakery), turned into the
// world. Every face's mapping is affine in the position on it, so each comes out as one small
// matrix: uv = A * q + b, with q the point in its cell (0..1 on each world axis) and uv in
// 0..1 across the texture. The renderer evaluates that per fragment from the fragment's
// position, so greedy-merged faces still tile one texture per cell.

import { inverse, type Rotation, rotate, type Vec3 } from "@voxyl/core";
import type { Element, Face, McSide } from "./library.ts";
import { rotatePoint16 } from "./variants.ts";

/** The world sides in the mesher's face order: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_SIDES: readonly McSide[] = ["east", "west", "up", "down", "south", "north"];

export const SIDE_NORMAL: Readonly<Record<McSide, Vec3>> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

export function sideOfNormal(n: Vec3): McSide {
  for (const side of FACE_SIDES) {
    const m = SIDE_NORMAL[side];
    if (m[0] === n[0] && m[1] === n[1] && m[2] === n[2]) return side;
  }
  throw new RangeError(`Not a side: ${n.join(", ")}`);
}

/** Minecraft's default texture position of a point on a side, in sixteenths. */
function auto(side: McSide, p: readonly number[]): [number, number] {
  const x = p[0] ?? 0;
  const y = p[1] ?? 0;
  const z = p[2] ?? 0;
  switch (side) {
    case "down":
      return [x, 16 - z];
    case "up":
      return [x, z];
    case "north":
      return [16 - x, 16 - y];
    case "south":
      return [x, 16 - y];
    case "west":
      return [z, 16 - y];
    case "east":
      return [16 - z, 16 - y];
  }
}

/** The face's texture rectangle when the model gives none: its box seen from that side. */
function autoRect(side: McSide, e: Element): [number, number, number, number] {
  const [a1, b1] = auto(side, e.from);
  const [a2, b2] = auto(side, e.to);
  return [Math.min(a1, a2), Math.min(b1, b2), Math.max(a1, a2), Math.max(b1, b2)];
}

/** A face's texture position (0..1) of a model point on it, in model space. */
function modelUv(side: McSide, e: Element, face: Face, p: readonly number[]): [number, number] {
  const [a1, b1, a2, b2] = autoRect(side, e);
  const [au, av] = auto(side, p);
  let s = a2 > a1 ? (au - a1) / (a2 - a1) : 0;
  let t = b2 > b1 ? (av - b1) / (b2 - b1) : 0;
  // A turned face turns its texture clockwise within the rectangle.
  switch (face.rotation ?? 0) {
    case 90:
      [s, t] = [t, 1 - s];
      break;
    case 180:
      [s, t] = [1 - s, 1 - t];
      break;
    case 270:
      [s, t] = [1 - t, s];
      break;
  }
  const [u1, v1, u2, v2] = face.uv ?? [a1, b1, a2, b2];
  return [(u1 + (u2 - u1) * s) / 16, (v1 + (v2 - v1) * t) / 16];
}

/**
 * The affine map from a point of the cell (world axes, 0..1) to texture coordinates for a
 * face of `element` on model side `side`, the model turned into the world by `rotation`:
 * [a00, a01, a02, b0, a10, a11, a12, b1]. With uvlock the texture keeps to the world, as if
 * the face had never turned.
 */
export function faceUvMap(
  element: Element,
  side: McSide,
  face: Face,
  rotation: Rotation,
  uvlock: boolean,
): Float32Array {
  const back = inverse(rotation);
  const worldSide = sideOfNormal(rotate(rotation, SIDE_NORMAL[side]));
  const uvAt = (q: Vec3): [number, number] => {
    const world16 = [q[0] * 16, q[1] * 16, q[2] * 16];
    if (uvlock) {
      const [u, v] = auto(worldSide, world16);
      return [u / 16, v / 16];
    }
    return modelUv(side, element, face, rotatePoint16(back, world16 as [number, number, number]));
  };
  const o = uvAt([0, 0, 0]);
  const x = uvAt([1, 0, 0]);
  const y = uvAt([0, 1, 0]);
  const z = uvAt([0, 0, 1]);
  return Float32Array.of(
    x[0] - o[0],
    y[0] - o[0],
    z[0] - o[0],
    o[0],
    x[1] - o[1],
    y[1] - o[1],
    z[1] - o[1],
    o[1],
  );
}
