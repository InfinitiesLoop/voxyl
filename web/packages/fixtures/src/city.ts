import type { World } from "@voxyl/core";
import { mulberry32 } from "./random.ts";

/** The semantics a generated city uses. Palettes for benchmarks map these. */
export const CITY_SEMANTICS = ["Ground", "Road", "Mass", "Glass", "Trim", "Roof", "Glow"] as const;
export type CitySemantic = (typeof CITY_SEMANTICS)[number];

export interface CityOptions {
  /** Stop adding lots once the world holds at least this many cells. */
  readonly targetCells: number;
  readonly seed?: number;
}

export interface CityStats {
  readonly lots: number;
  /** Lot index range on each horizontal axis, inclusive. */
  readonly lotRange: number;
  /** World-space bounds of everything generated, inclusive. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Lots are square: a 4-cell road on two sides and a building footprint inside. */
export const LOT_PITCH = 32;
const ROAD = 4;

/**
 * Fills `world` with a deterministic city: lots spiral out from the origin until the target
 * cell count is reached, so every size is roughly square and centred on [0, 0]. Buildings are
 * hollow shells with floors every four layers, window bands, trim and a roof, and grow taller
 * toward the centre. Ground sits at y = 0, buildings above it.
 */
export function generateCity(world: World, options: CityOptions): CityStats {
  const rand = mulberry32(options.seed ?? 1);
  const ids = Object.fromEntries(
    CITY_SEMANTICS.map((s) => [s, world.states.intern({ semantic: s })]),
  ) as Record<CitySemantic, number>;

  let lots = 0;
  let ring = 0;
  let maxY = 0;
  while (world.cellCount < options.targetCells) {
    for (const [i, j] of ringLots(ring)) {
      const top = buildLot(world, ids, rand, i, j, ring);
      maxY = Math.max(maxY, top);
      lots++;
      if (world.cellCount >= options.targetCells) break;
    }
    ring++;
  }
  const lotRange = ring - 1;
  return {
    lots,
    lotRange,
    min: [-lotRange * LOT_PITCH, 0, -lotRange * LOT_PITCH],
    max: [(lotRange + 1) * LOT_PITCH - 1, maxY, (lotRange + 1) * LOT_PITCH - 1],
  };
}

/** Lot coordinates on the square ring at Chebyshev distance `ring` from lot [0, 0]. */
function* ringLots(ring: number): Generator<[number, number]> {
  if (ring === 0) {
    yield [0, 0];
    return;
  }
  for (let i = -ring; i <= ring; i++) yield [i, -ring];
  for (let j = -ring + 1; j <= ring; j++) yield [ring, j];
  for (let i = ring - 1; i >= -ring; i--) yield [i, ring];
  for (let j = ring - 1; j > -ring; j--) yield [-ring, j];
}

/** Builds one lot and returns the highest y it used. */
function buildLot(
  world: World,
  ids: Record<CitySemantic, number>,
  rand: () => number,
  i: number,
  j: number,
  ring: number,
): number {
  const x0 = i * LOT_PITCH;
  const z0 = j * LOT_PITCH;
  const x1 = x0 + LOT_PITCH - 1;
  const z1 = z0 + LOT_PITCH - 1;

  // Ground: roads along the lot's low edges, pavement elsewhere.
  world.fillBox(x0, 0, z0, x1, 0, z1, ids.Ground);
  world.fillBox(x0, 0, z0, x1, 0, z0 + ROAD - 1, ids.Road);
  world.fillBox(x0, 0, z0, x0 + ROAD - 1, 0, z1, ids.Road);

  // Some lots stay open as plazas.
  if (rand() < 0.08) return 0;

  const room = LOT_PITCH - ROAD - 2;
  const w = 12 + Math.floor(rand() * (room - 11));
  const d = 12 + Math.floor(rand() * (room - 11));
  const bx0 = x0 + ROAD + 1 + Math.floor(rand() * (room - w + 1));
  const bz0 = z0 + ROAD + 1 + Math.floor(rand() * (room - d + 1));
  const bx1 = bx0 + w - 1;
  const bz1 = bz0 + d - 1;
  const centre = 1 / (1 + ring * 0.15);
  const floors = 2 + Math.floor((rand() ** 2 * 26 + rand() * 4) * centre);
  const height = floors * 4;

  for (let y = 1; y <= height; y++) {
    const band = y % 4;
    if (band === 0) {
      // A trim band outside, a floor slab inside.
      world.fillBox(bx0, y, bz0, bx1, y, bz1, ids.Mass);
      ring4(world, bx0, bz0, bx1, bz1, y, ids.Trim);
    } else if (band === 1) {
      ring4(world, bx0, bz0, bx1, bz1, y, ids.Mass);
    } else {
      // Window rows: glass between mullions every third cell, solid corners.
      ring4(world, bx0, bz0, bx1, bz1, y, ids.Glass);
      for (let x = bx0; x <= bx1; x += 3) {
        world.setId(x, y, bz0, ids.Mass);
        world.setId(x, y, bz1, ids.Mass);
      }
      for (let z = bz0; z <= bz1; z += 3) {
        world.setId(bx0, y, z, ids.Mass);
        world.setId(bx1, y, z, ids.Mass);
      }
      for (const [x, z] of [
        [bx0, bz0],
        [bx1, bz0],
        [bx0, bz1],
        [bx1, bz1],
      ] as const) {
        world.setId(x, y, z, ids.Mass);
      }
    }
  }

  // Roof slab, a parapet, and on taller towers a glowing crown.
  const roofY = height + 1;
  world.fillBox(bx0, roofY, bz0, bx1, roofY, bz1, ids.Roof);
  ring4(world, bx0, bz0, bx1, bz1, roofY + 1, ids.Trim);
  let top = roofY + 1;
  if (floors >= 12) {
    ring4(world, bx0 + 2, bz0 + 2, bx1 - 2, bz1 - 2, roofY + 2, ids.Glow);
    top = roofY + 2;
  }
  return top;
}

/** The four walls of a one-cell-high rectangle. */
function ring4(
  world: World,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  id: number,
) {
  world.fillBox(x0, y, z0, x1, y, z0, id);
  world.fillBox(x0, y, z1, x1, y, z1, id);
  world.fillBox(x0, y, z0, x0, y, z1, id);
  world.fillBox(x1, y, z0, x1, y, z1, id);
}
