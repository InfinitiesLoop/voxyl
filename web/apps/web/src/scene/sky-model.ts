// The sky at a time of day, after Minecraft's (ClientLevel.getSkyColor, FogRenderer,
// DimensionSpecialEffects.getSunriseColor): plain numbers the sky shader takes as uniforms.
// The sun rises in the project's real east (settings.north), crosses straight overhead at
// noon and sets in the west; the moon is opposite it, and the stars turn with them. Unlike
// Minecraft's, this world has rings: an arc across the real southern sky (see sky.ts).

import type { Direction } from "@voxyl/core";

export type Vec3 = readonly [number, number, number];
export type Rgb = readonly [number, number, number];

/** Minecraft's plains sky and fog colours (sRGB, 0..1). */
const BIOME_SKY: Rgb = [0x78 / 255, 0xa7 / 255, 0xff / 255];
const BIOME_FOG: Rgb = [0xc0 / 255, 0xd8 / 255, 0xff / 255];
/** How far fog moves toward the sky colour at Minecraft's 12-chunk render distance. */
const FOG_TO_SKY = 1 - (0.25 + (0.75 * 12) / 32) ** 0.25;

export const NOON = 12;
export const HOURS = 24;

export interface SkyState {
  /** Unit vector toward the sun, in world axes (y up); the moon is its opposite. */
  readonly sun: Vec3;
  /** Unit vector along the axis the sky turns about (the real north). */
  readonly pole: Vec3;
  /** Minecraft's sky darkening as the lit shader takes it: 0 at night, 1 by day. */
  readonly daylight: number;
  /** The sky overhead and at the horizon (sRGB, 0..1). */
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  /** The sunrise or sunset glow, its strength (0 when there is none) and its side (horizontal). */
  readonly glow: Rgb;
  readonly glowAlpha: number;
  readonly glowSide: Vec3;
  /** How bright the stars are, 0 by day. */
  readonly stars: number;
  /** How bright the world's rings are: bright at night, faint against the day sky. */
  readonly rings: number;
}

/** Ring brightness at night and at noon. */
const RINGS_NIGHT = 0.7;
const RINGS_DAY = 0.16;

/** The project's real east, in its own axes (x, z), for each choice of settings.north. */
const REAL_EAST: Record<Direction, readonly [number, number]> = {
  north: [1, 0],
  east: [0, 1],
  south: [-1, 0],
  west: [0, -1],
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Wraps any number of hours into 0..24. */
export function wrapHours(hours: number): number {
  return ((hours % HOURS) + HOURS) % HOURS;
}

/** The sky at `hours` (0 midnight, 12 noon) over a project whose real north is `north`. */
export function skyAt(hours: number, north: Direction): SkyState {
  // Minecraft's celestial angle: 0 at noon, half a turn at midnight.
  const angle = ((wrapHours(hours) - NOON) / HOURS) * 2 * Math.PI;
  const height = Math.cos(angle);
  const [ex, ez] = REAL_EAST[north];
  // At 6:00 the sun is due east; at 18:00 due west.
  const s = -Math.sin(angle);
  const sun: Vec3 = [s * ex, height, s * ez];
  // North is east turned a quarter left, seen from above.
  const pole: Vec3 = [ez, 0, -ex];

  const brightness = clamp01(height * 2 + 0.5);
  const zenith: Rgb = [
    BIOME_SKY[0] * brightness,
    BIOME_SKY[1] * brightness,
    BIOME_SKY[2] * brightness,
  ];
  const fogGrey = brightness * 0.94 + 0.06;
  const fogBlue = brightness * 0.91 + 0.09;
  const fog: Rgb = [BIOME_FOG[0] * fogGrey, BIOME_FOG[1] * fogGrey, BIOME_FOG[2] * fogBlue];
  const horizon: Rgb = [
    fog[0] + (zenith[0] - fog[0]) * FOG_TO_SKY,
    fog[1] + (zenith[1] - fog[1]) * FOG_TO_SKY,
    fog[2] + (zenith[2] - fog[2]) * FOG_TO_SKY,
  ];

  let glow: Rgb = [0, 0, 0];
  let glowAlpha = 0;
  if (height >= -0.4 && height <= 0.4) {
    const i = (height / 0.4) * 0.5 + 0.5;
    const j = 1 - (1 - Math.sin(i * Math.PI)) * 0.99;
    glow = [i * 0.3 + 0.7, i * i * 0.7 + 0.2, 0.2];
    glowAlpha = j * j;
  }
  const side = s >= 0 ? 1 : -1;
  const glowSide: Vec3 = [side * ex, 0, side * ez];

  const starLevel = clamp01(1 - (height * 2 + 0.25));
  return {
    sun,
    pole,
    daylight: clamp01(height * 2 + 0.2),
    zenith,
    horizon,
    glow,
    glowAlpha,
    glowSide,
    stars: starLevel * starLevel * 0.5,
    rings: RINGS_NIGHT + (RINGS_DAY - RINGS_NIGHT) * brightness,
  };
}

/** "06:30" for 6.5 hours. */
export function clockLabel(hours: number): string {
  const minutes = Math.round(wrapHours(hours) * 60) % (HOURS * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
