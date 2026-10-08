// A block's inventory icon: one orthographic picture of its real model (a slab stays short,
// stairs keep their step, a fence is its post), not a flat face texture. Pure CPU, so the
// world worker can bake a few at a time without a second renderer. The camera matches the
// Godot baker: a raised three-quarter view from the west-north, so a default stair shows
// its step.

import { IDENTITY } from "@voxyl/core";
import type { CompiledFace, Libraries } from "./compile.ts";
import { parseBlockRef, type Texture } from "./library.ts";
import { compileShape, type ShapeFace } from "./shape.ts";

/** Square icons. Cells draw them a little smaller, so this stays near 1:1. */
export const ICON_RES = 64;

/**
 * How much of the world one icon covers, in cells. A unit cube sits inside with a margin,
 * the same framing as the Godot baker.
 */
const CELL_WORLD = 1.85;

type Vec3 = [number, number, number];

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

/** From the block toward the eye. */
const CAM = norm([-0.9, 1, -1.2]);
/** Screen right and screen up, from a look-at with world up. */
const RIGHT = norm(cross([0, 1, 0], CAM));
const UP = cross(CAM, RIGHT);

/** Right-handed turn about Y, degrees. */
function rotY(v: Vec3, deg: number): Vec3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

const KEY = norm(add(rotY(CAM, -28), [0, 0.7, 0]));
const FILL = norm(add(scale(rotY(CAM, 40), -1), [0, 0.25, 0]));
/** Ambient (0.32 × a cool grey) plus the key and fill, as in the Godot light rig. */
const AMBIENT: Vec3 = [0.6 * 0.32, 0.62 * 0.32, 0.68 * 0.32];

function shadeOf(normal: Vec3): Vec3 {
  const lit = Math.max(0, dot(normal, KEY)) * 1.05 + Math.max(0, dot(normal, FILL)) * 0.28;
  return [AMBIENT[0] + lit, AMBIENT[1] + lit, AMBIENT[2] + lit];
}

function rgbOf(hex: string | null | undefined): Vec3 {
  const n = hex ? Number.parseInt(hex.slice(1), 16) : Number.NaN;
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function texel(t: number, size: number): number {
  let u = t % 1;
  if (u < 0) u += 1;
  const i = Math.floor(u * size);
  return i >= size ? size - 1 : i;
}

/** uv = A * q + b, q in 0..1 across the cell. */
function uvAt(map: Float32Array, q: Vec3): [number, number] {
  const at = (i: number) => map[i] ?? 0;
  return [
    at(0) * q[0] + at(1) * q[1] + at(2) * q[2] + at(3),
    at(4) * q[0] + at(5) * q[1] + at(6) * q[2] + at(7),
  ];
}

interface CamPoint {
  /** Position in camera axes: screen right, screen up, and toward the eye. */
  readonly rx: number;
  readonly uy: number;
  readonly z: number;
  readonly u: number;
  readonly v: number;
}

function toCam(p: Vec3, uv: readonly [number, number]): CamPoint {
  return { rx: dot(p, RIGHT), uy: dot(p, UP), z: dot(p, CAM), u: uv[0], v: uv[1] };
}

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly u: number;
  readonly v: number;
}

function toScreen(c: CamPoint, size: number): ScreenPoint {
  const half = CELL_WORLD / 2;
  return {
    x: (c.rx / half) * (size / 2) + size / 2,
    y: (-c.uy / half) * (size / 2) + size / 2,
    z: c.z,
    u: c.u,
    v: c.v,
  };
}

interface Prepared {
  readonly corners: readonly CamPoint[];
  readonly texture: Texture | null;
  readonly tint: Vec3;
  readonly shade: Vec3;
  readonly flat: Vec3;
  readonly alpha: CompiledFace["alpha"];
  readonly depth: number;
}

/**
 * The block's icon, `size`×`size` RGBA, or null when no library has it. Transparent where
 * the model doesn't cover. `size` defaults to {@link ICON_RES}.
 */
export function bakeBlockIcon(
  libraries: Libraries,
  ref: string,
  size = ICON_RES,
): Uint8Array | null {
  const shape = compileShape(libraries, ref, IDENTITY);
  const faces = shape?.variants[0];
  if (!shape || !faces || faces.length === 0 || size < 8) return null;
  const parsed = parseBlockRef(ref);
  const library = parsed ? libraries.get(parsed.library) : undefined;
  const fallback = rgbOf(parsed ? library?.blocks[parsed.block]?.color : undefined);
  const prepared = faces.map((face) => prepare(face, library?.textures, fallback));

  const pixels = new Uint8Array(size * size * 4);
  const depth = new Float32Array(size * size);
  depth.fill(-1e9);
  for (const face of prepared) {
    if (face.alpha !== "blend") drawFace(face, pixels, depth, size, false);
  }
  const glass = prepared.filter((face) => face.alpha === "blend").sort((a, b) => a.depth - b.depth);
  for (const face of glass) drawFace(face, pixels, depth, size, true);
  return pixels;
}

function prepare(
  face: ShapeFace,
  textures: Readonly<Record<string, Texture>> | undefined,
  fallback: Vec3,
): Prepared {
  const parsed = parseBlockRef(face.face.texture);
  const texture = parsed ? textures?.[parsed.block] : undefined;
  const points = face.corners.map((c): Vec3 => [c[0] / 16 - 0.5, c[1] / 16 - 0.5, c[2] / 16 - 0.5]);
  const corners = points.map((p) => {
    const q: Vec3 = [(p[0] ?? 0) + 0.5, (p[1] ?? 0) + 0.5, (p[2] ?? 0) + 0.5];
    return toCam(p, uvAt(face.face.map, q));
  });
  const o = points[0] ?? [0, 0, 0];
  const e1 = sub(points[1] ?? o, o);
  const e2 = sub(points[3] ?? o, o);
  let n = cross(e1, e2);
  if (dot(n, CAM) < 0) n = scale(n, -1);
  const len = Math.hypot(n[0], n[1], n[2]);
  const shade = len > 1e-8 ? shadeOf(scale(n, 1 / len)) : AMBIENT;
  const tint = rgbOf(face.face.tint);
  const depth = corners.reduce((sum, c) => sum + c.z, 0) / Math.max(1, corners.length);
  return {
    corners,
    texture: texture ?? null,
    tint,
    shade,
    flat: [
      Math.min(255, Math.round(fallback[0] * shade[0])),
      Math.min(255, Math.round(fallback[1] * shade[1])),
      Math.min(255, Math.round(fallback[2] * shade[2])),
    ],
    alpha: face.face.alpha,
    depth,
  };
}

function drawFace(
  face: Prepared,
  pixels: Uint8Array,
  depth: Float32Array,
  size: number,
  blend: boolean,
): void {
  const placed = face.corners.map((c) => toScreen(c, size));
  const tri = (i: number, j: number, k: number) => {
    const a = placed[i];
    const b = placed[j];
    const c = placed[k];
    if (a && b && c) raster(a, b, c, face, pixels, depth, size, blend);
  };
  tri(0, 1, 2);
  tri(0, 2, 3);
}

function raster(
  a: ScreenPoint,
  b: ScreenPoint,
  c: ScreenPoint,
  face: Prepared,
  pixels: Uint8Array,
  depth: Float32Array,
  size: number,
  blend: boolean,
): void {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(denom) < 1e-8) return;
  const tex = face.texture;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / denom;
      const w1 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / denom;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-3 || w1 < -1e-3 || w2 < -1e-3) continue;
      const z = w0 * a.z + w1 * b.z + w2 * c.z;
      const i = y * size + x;
      if (z < (depth[i] ?? -1e9)) continue;
      const u = w0 * a.u + w1 * b.u + w2 * c.u;
      const v = w0 * a.v + w1 * b.v + w2 * c.v;
      let r: number;
      let g: number;
      let bch: number;
      let al: number;
      if (tex) {
        const p = (texel(v, tex.size) * tex.size + texel(u, tex.size)) * 4;
        const tr = tex.rgba[p] ?? 0;
        const tg = tex.rgba[p + 1] ?? 0;
        const tb = tex.rgba[p + 2] ?? 0;
        al = tex.rgba[p + 3] ?? 0;
        if (face.alpha === "cutout" && al < 128) continue;
        if (al === 0) continue;
        r = Math.min(255, Math.round((tr * face.tint[0] * face.shade[0]) / 255));
        g = Math.min(255, Math.round((tg * face.tint[1] * face.shade[1]) / 255));
        bch = Math.min(255, Math.round((tb * face.tint[2] * face.shade[2]) / 255));
      } else {
        r = face.flat[0];
        g = face.flat[1];
        bch = face.flat[2];
        al = 255;
      }
      const o = i * 4;
      if (blend && al < 255) {
        const sa = al / 255;
        const da = (pixels[o + 3] ?? 0) / 255;
        const outA = sa + da * (1 - sa);
        const over = (src: number, dst: number) =>
          outA === 0 ? 0 : Math.round((src * sa + dst * da * (1 - sa)) / outA);
        pixels[o] = over(r, pixels[o] ?? 0);
        pixels[o + 1] = over(g, pixels[o + 1] ?? 0);
        pixels[o + 2] = over(bch, pixels[o + 2] ?? 0);
        pixels[o + 3] = Math.round(outA * 255);
      } else {
        pixels[o] = r;
        pixels[o + 1] = g;
        pixels[o + 2] = bch;
        pixels[o + 3] = face.alpha === "opaque" ? 255 : al;
      }
      depth[i] = z;
    }
  }
}
