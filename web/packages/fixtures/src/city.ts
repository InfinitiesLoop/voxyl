import { ROOT_PALETTE, type SemanticId, type SemanticRegistry, type World } from "@voxyl/core";
import { archSlot, edgeBetween } from "@voxyl/shapes";
import { mulberry32 } from "./random.ts";

/** The semantics a generated city uses. Palettes for benchmarks map these. */
export const CITY_SEMANTICS = ["Ground", "Road", "Mass", "Glass", "Trim", "Roof", "Glow"] as const;
export type CitySemantic = (typeof CITY_SEMANTICS)[number];

/**
 * The shaped parts a decorated city is built from, one semantic each (a "Roof Tile" is a Roof
 * that places the tile shape), so picking a part with the middle button puts that part in the
 * hand and not a full block. `of` is the whole-block semantic it looks like.
 */
export const CITY_PARTS = [
  { of: "Trim", shape: "edge2", name: "Trim Post" },
  { of: "Trim", shape: "edge1", name: "Trim Strip" },
  { of: "Trim", shape: "edge4", name: "Trim Pillar" },
  { of: "Trim", shape: "hollow1", name: "Trim Hollow Cover" },
  { of: "Mass", shape: "face2", name: "Mass Panel" },
  { of: "Mass", shape: "face1", name: "Mass Cover" },
  { of: "Roof", shape: "roof_tile", name: "Roof Tile" },
  { of: "Roof", shape: "roof_outer_corner", name: "Roof Outer Corner" },
  { of: "Roof", shape: "roof_ridge", name: "Gabled Roof Ridge" },
  { of: "Roof", shape: "roof_smart_ridge", name: "Hip Roof Ridge" },
] as const;
export type CityPart = (typeof CITY_PARTS)[number];

/** The key a part has in the city's shared palette. */
export const partKey = (part: CityPart): string => part.name.toLowerCase().replace(/\s+/g, "-");

/** Where a city is generated: a world and the registry its semantics go in (a Project fits). */
export interface CityTarget {
  readonly world: World;
  readonly semantics: SemanticRegistry;
}

export interface CityOptions {
  /** Stop adding lots once the world holds at least this many cells. */
  readonly targetCells: number;
  readonly seed?: number;
  /**
   * Decorate with shaped parts: microblock ledges, sills, pilasters, window frames and corner
   * pillars on the facades, and roof tiles on the roofs (hip roofs on low buildings, a tiled
   * eave on towers). The blocks underneath are the same city either way.
   */
  readonly parts?: boolean;
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
 * Fills the target's world with a deterministic city, adding CITY_SEMANTICS to its registry: lots spiral out from the origin until the target
 * cell count is reached, so every size is roughly square and centred on [0, 0]. Buildings are
 * hollow shells with floors every four layers, window bands, trim and a roof, and grow taller
 * toward the centre. Ground sits at y = 0, buildings above it.
 */
export function generateCity(target: CityTarget, options: CityOptions): CityStats {
  const world = target.world;
  const rand = mulberry32(options.seed ?? 1);
  const semantics = Object.fromEntries(
    CITY_SEMANTICS.map((s) => [s, target.semantics.ensure(s)]),
  ) as Record<CitySemantic, SemanticId>;
  const ids = Object.fromEntries(
    CITY_SEMANTICS.map((s) => [s, world.states.intern({ semantic: semantics[s] })]),
  ) as Record<CitySemantic, number>;

  const parts = options.parts ? new PartIds(world, partSemantics(target.semantics)) : null;

  let lots = 0;
  let ring = 0;
  let maxY = 0;
  while (world.cellCount < options.targetCells) {
    for (const [i, j] of ringLots(ring)) {
      const top = buildLot(world, ids, rand, i, j, ring, parts);
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
  parts: PartIds | null,
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

  // Roof slab, a parapet (or roof tiles), and on taller towers a glowing crown.
  const roofY = height + 1;
  world.fillBox(bx0, roofY, bz0, bx1, roofY, bz1, ids.Roof);
  const footprint = { x0: bx0, z0: bz0, x1: bx1, z1: bz1 };
  // Decorations draw from their own sequence, so the blocks match the undecorated city.
  if (parts) {
    const decor = mulberry32(((i * 73856093) ^ (j * 19349663)) >>> 0);
    decorateFacades(world, parts, decor, footprint, height);
  }
  let top = roofY + 1;
  if (parts && floors < 12) {
    top = hipRoof(world, parts, footprint, roofY + 1);
  } else if (parts) {
    tileRing(world, parts, footprint, roofY + 1);
  } else {
    ring4(world, bx0, bz0, bx1, bz1, roofY + 1, ids.Trim);
  }
  if (floors >= 12) {
    ring4(world, bx0 + 2, bz0 + 2, bx1 - 2, bz1 - 2, roofY + 2, ids.Glow);
    top = Math.max(top, roofY + 2);
  }
  return top;
}

interface Footprint {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

/**
 * Each part's semantic: the one a prepared project already derived from its city palette, or
 * (in a bare registry) a new one that places the shape.
 */
function partSemantics(registry: SemanticRegistry): Map<string, SemanticId> {
  return new Map(
    CITY_PARTS.map((part) => [
      `${part.of}|${part.shape}`,
      registry.byName(part.name, ROOT_PALETTE) ??
        registry.add(part.name, { form: { shape: part.shape } }),
    ]),
  );
}

/** Interned single-part states, by semantic, shape and slot. */
class PartIds {
  readonly #world: World;
  readonly #semantics: ReadonlyMap<string, SemanticId>;
  readonly #ids = new Map<string, number>();
  constructor(world: World, semantics: ReadonlyMap<string, SemanticId>) {
    this.#world = world;
    this.#semantics = semantics;
  }
  get(semantic: CitySemantic, shape: string, slot: number): number {
    const key = `${semantic}|${shape}|${slot}`;
    let id = this.#ids.get(key);
    if (id === undefined) {
      const owner = this.#semantics.get(`${semantic}|${shape}`);
      if (owner === undefined) throw new Error(`The city has no ${shape} part of ${semantic}`);
      id = this.#world.states.intern({ parts: [{ semantic: owner, shape, slot }] });
      this.#ids.set(key, id);
    }
    return id;
  }
}

// Microblock sides: 0 -Y, 1 +Y, 2 -Z, 3 +Z, 4 -X, 5 +X.
const DOWN = 0;
const UP = 1;

interface FacadeCell {
  readonly x: number;
  readonly z: number;
  /** The side of the cell that faces the wall. */
  readonly wall: number;
  /** Position along the wall, from its low end. */
  readonly along: number;
  /** True on the wall's mullion columns (every third cell and both ends). */
  readonly mullion: boolean;
}

/** The cells just outside each wall. */
function facadeCells(b: Footprint): FacadeCell[] {
  const out: FacadeCell[] = [];
  const wx = b.x1 - b.x0;
  const wz = b.z1 - b.z0;
  for (let x = b.x0; x <= b.x1; x++) {
    const along = x - b.x0;
    const mullion = along % 3 === 0 || along === wx;
    out.push({ x, z: b.z0 - 1, wall: 3, along, mullion });
    out.push({ x, z: b.z1 + 1, wall: 2, along, mullion });
  }
  for (let z = b.z0; z <= b.z1; z++) {
    const along = z - b.z0;
    const mullion = along % 3 === 0 || along === wz;
    out.push({ x: b.x0 - 1, z, wall: 5, along, mullion });
    out.push({ x: b.x1 + 1, z, wall: 4, along, mullion });
  }
  return out;
}

/**
 * Microblocks on the facades, in one of three styles. Ledges: a post along the top of every
 * trim band, a strip sill under each window and a panel pilaster on each mullion. Frames: a
 * hollow cover round each window, a cover band along each solid row and a pillar up each
 * corner. Plain: none.
 */
function decorateFacades(
  world: World,
  parts: PartIds,
  rand: () => number,
  b: Footprint,
  height: number,
): void {
  const style = rand();
  if (style < 0.2) return;
  const cells = facadeCells(b);
  if (style < 0.6) {
    for (let y = 1; y <= height; y++) {
      const band = y % 4;
      for (const c of cells) {
        if (band === 0) {
          world.setId(c.x, y, c.z, parts.get("Trim", "edge2", edgeBetween(c.wall, UP)));
        } else if (band >= 2 && c.mullion) {
          world.setId(c.x, y, c.z, parts.get("Mass", "face2", c.wall));
        } else if (band === 2) {
          world.setId(c.x, y, c.z, parts.get("Trim", "edge1", edgeBetween(c.wall, DOWN)));
        }
      }
    }
    return;
  }
  for (let y = 1; y <= height; y++) {
    const band = y % 4;
    for (const c of cells) {
      if (band >= 2 && !c.mullion) {
        world.setId(c.x, y, c.z, parts.get("Trim", "hollow1", c.wall));
      } else if (band === 1) {
        world.setId(c.x, y, c.z, parts.get("Mass", "face1", c.wall));
      }
    }
    // Vertical edges (slots 0-3): bit 0 toward +Z, bit 1 toward +X, i.e. toward the building.
    world.setId(b.x0 - 1, y, b.z0 - 1, parts.get("Trim", "edge4", 3));
    world.setId(b.x1 + 1, y, b.z0 - 1, parts.get("Trim", "edge4", 1));
    world.setId(b.x0 - 1, y, b.z1 + 1, parts.get("Trim", "edge4", 2));
    world.setId(b.x1 + 1, y, b.z1 + 1, parts.get("Trim", "edge4", 0));
  }
}

// Roof tiles stand on the floor (side 0). The slope faces -Z at turn 0, -X at 1, +Z at 2 and
// +X at 3; an outer corner slopes to -Z and +X at turn 0, and each turn moves it a quarter.
const TILE_TURN = { north: 0, west: 1, south: 2, east: 3 } as const;
const CORNER_TURN = { northEast: 0, northWest: 1, southWest: 2, southEast: 3 } as const;

/** One ring of roof tiles sloping outward around a footprint, at height y. */
function tileRing(world: World, parts: PartIds, b: Footprint, y: number): void {
  const tile = (turn: number) => parts.get("Roof", "roof_tile", archSlot(0, turn));
  for (let x = b.x0 + 1; x < b.x1; x++) {
    world.setId(x, y, b.z0, tile(TILE_TURN.north));
    world.setId(x, y, b.z1, tile(TILE_TURN.south));
  }
  for (let z = b.z0 + 1; z < b.z1; z++) {
    world.setId(b.x0, y, z, tile(TILE_TURN.west));
    world.setId(b.x1, y, z, tile(TILE_TURN.east));
  }
  const corner = (turn: number) => parts.get("Roof", "roof_outer_corner", archSlot(0, turn));
  world.setId(b.x1, y, b.z0, corner(CORNER_TURN.northEast));
  world.setId(b.x0, y, b.z0, corner(CORNER_TURN.northWest));
  world.setId(b.x0, y, b.z1, corner(CORNER_TURN.southWest));
  world.setId(b.x1, y, b.z1, corner(CORNER_TURN.southEast));
}

/** A hip roof: rings of tiles stepping in and up to a ridge. Returns its top y. */
function hipRoof(world: World, parts: PartIds, b: Footprint, y0: number): number {
  const peak = parts.get("Roof", "roof_smart_ridge", archSlot(0, 0));
  for (let k = 0; ; k++) {
    const r = { x0: b.x0 + k, z0: b.z0 + k, x1: b.x1 - k, z1: b.z1 - k };
    const y = y0 + k;
    if (r.x0 > r.x1 || r.z0 > r.z1) return y - 1;
    if (r.x0 === r.x1 || r.z0 === r.z1) {
      // A ridge along the long side, with a peak at each end.
      const alongX = r.z0 === r.z1;
      const ridge = parts.get("Roof", "roof_ridge", archSlot(0, alongX ? 0 : 1));
      for (let x = r.x0; x <= r.x1; x++) {
        for (let z = r.z0; z <= r.z1; z++) {
          const end = alongX ? x === r.x0 || x === r.x1 : z === r.z0 || z === r.z1;
          world.setId(x, y, z, end ? peak : ridge);
        }
      }
      return y;
    }
    tileRing(world, parts, r, y);
  }
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
