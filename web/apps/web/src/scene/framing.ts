// Camera math for presets and orbiting, after the Godot app's CameraFraming: aim at a box of
// cells from a compass side and an elevation, and back off until it fits the frame. Pure
// math, so it tests in Node and agent captures (Phase 4) can share it.

import type { Direction } from "@voxyl/core";
import { bearingVector } from "../editor/compass.ts";

export type V3 = readonly [number, number, number];

/** A box of cells: `min` inclusive, `max` exclusive (cell corners). */
export interface CellBox {
  readonly min: V3;
  readonly max: V3;
}

export interface Pose {
  readonly position: V3;
  readonly target: V3;
}

/** Named elevations, in degrees above the horizon. Top stops short of straight down. */
export const ELEVATIONS = { top: 89, high: 50, iso: 35.26, mid: 30, low: 12, level: 0 } as const;

export function centreOf(box: CellBox): V3 {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
}

/**
 * The pose that frames `box` seen from `bearing` (degrees clockwise from the real north,
 * where the camera stands) at `elevation` degrees, for a camera of vertical field of view
 * `fov` degrees and `aspect` width over height. `margin` above 1 leaves room around it.
 * The nearest distance at which all eight corners are in view, found by bisection.
 */
export function framePose(
  box: CellBox,
  bearing: number,
  elevation: number,
  north: Direction,
  fov: number,
  aspect: number,
  margin = 1.25,
): Pose {
  const target = centreOf(box);
  const [hx, hz] = bearingVector(bearing, north);
  const e = (Math.max(-89, Math.min(89, elevation)) * Math.PI) / 180;
  const dir: V3 = [hx * Math.cos(e), Math.sin(e), hz * Math.cos(e)];
  const tanV = Math.tan((fov * Math.PI) / 360) / margin;
  const tanH = tanV * aspect;
  const corners: V3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push([
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2],
    ]);
  }
  const at = (d: number): V3 => [
    target[0] + dir[0] * d,
    target[1] + dir[1] * d,
    target[2] + dir[2] * d,
  ];
  let lo = 0.5;
  let hi = 20000;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (fits(at(mid), target, corners, tanH, tanV)) hi = mid;
    else lo = mid;
  }
  return { position: at(hi), target };
}

/** Whether every corner is inside the view of a camera at `pos` looking at `target`. */
function fits(pos: V3, target: V3, corners: readonly V3[], tanH: number, tanV: number): boolean {
  const f = normalize([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]]);
  // Up is world up unless looking straight down, where it is "north" (-z).
  const worldUp: V3 = Math.abs(f[1]) < 0.999 ? [0, 1, 0] : [0, 0, -1];
  const r = normalize(cross(f, worldUp));
  const u = cross(r, f);
  for (const c of corners) {
    const q: V3 = [c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]];
    const depth = dot(q, f);
    if (depth <= 0.05) return false;
    if (Math.abs(dot(q, r)) > tanH * depth || Math.abs(dot(q, u)) > tanV * depth) return false;
  }
  return true;
}

/**
 * The half height an orthographic camera needs to show `box`, seen along `forward` with
 * `aspect`: the box's corners projected on the view's up and right axes, with `margin`.
 */
export function orthoHalfHeight(box: CellBox, forward: V3, aspect: number, margin = 1.25): number {
  const f = normalize(forward);
  const worldUp: V3 = Math.abs(f[1]) < 0.999 ? [0, 1, 0] : [0, 0, -1];
  const r = normalize(cross(f, worldUp));
  const u = cross(r, f);
  const c = centreOf(box);
  let half = 0;
  for (let i = 0; i < 8; i++) {
    const q: V3 = [
      (i & 1 ? box.max[0] : box.min[0]) - c[0],
      (i & 2 ? box.max[1] : box.min[1]) - c[1],
      (i & 4 ? box.max[2] : box.min[2]) - c[2],
    ];
    half = Math.max(half, Math.abs(dot(q, u)), Math.abs(dot(q, r)) / aspect);
  }
  return Math.max(1, half * margin);
}

/**
 * One step of an orbit: `position` turned `radians` about the vertical through `centre`
 * (positive turns counter-clockwise seen from above), still at the same height.
 */
export function orbitStep(position: V3, centre: V3, radians: number): V3 {
  const ox = position[0] - centre[0];
  const oz = position[2] - centre[2];
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [centre[0] + ox * c + oz * s, position[1], centre[2] - ox * s + oz * c];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
