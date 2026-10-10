// Compass words and elevations the camera tools share (capture, and the tab's view_set).
// Degrees are clockwise from the real north; the camera stands there and looks at the build.

import { ToolError } from "./tool.ts";

const BEARINGS: Readonly<Record<string, number>> = {
  n: 0,
  north: 0,
  ne: 45,
  e: 90,
  east: 90,
  se: 135,
  s: 180,
  south: 180,
  sw: 225,
  w: 270,
  west: 270,
  nw: 315,
};

/** Named elevations, degrees above the horizon. Top stops short of straight down. */
const ELEVATIONS: Readonly<Record<string, number>> = {
  top: 89,
  high: 50,
  iso: 35,
  mid: 30,
  low: 12,
  eye: 8,
  level: 0,
};

/** Degrees clockwise from north, from a compass word or a number. */
export function parseBearing(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ToolError("bad_argument", "from must be a finite number.");
    return ((value % 360) + 360) % 360;
  }
  const found = BEARINGS[value.trim().toLowerCase()];
  if (found === undefined) {
    throw new ToolError(
      "bad_argument",
      "from must be a compass side (n, ne, e, se, s, sw, w, nw, or north, east, south, west) or degrees clockwise from north.",
    );
  }
  return found;
}

/** Degrees above the horizon, from a word (top, high, iso, mid, low, eye, level) or a number. */
export function parseElevation(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ToolError("bad_argument", "elevation must be a finite number.");
    }
    return Math.max(-89, Math.min(89, value));
  }
  const found = ELEVATIONS[value.trim().toLowerCase()];
  if (found === undefined) {
    throw new ToolError(
      "bad_argument",
      `elevation must be one of ${Object.keys(ELEVATIONS).join(", ")}, or degrees above the horizon.`,
    );
  }
  return found;
}
