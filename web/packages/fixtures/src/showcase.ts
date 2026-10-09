// A sample that shows every block of a library: one semantic per block, each look naming its
// block. In front of that catalogue is a walled court (a gate, a garden, a house, a pavilion)
// so the demo reads as a place: stairs, glass, fences and lamps together, not only a grid.
// Oriented blocks also stand in their other orientations (logs on each axis, stairs facing
// each way and upside down).

import type { Library } from "@voxyl/blocks";
import { type Project, type Rotation, rotationFacing, turn, turnClockwise } from "@voxyl/core";

/** The step between blocks in the catalogue. */
const STEP = 3;
/** The catalogue starts after the court, so the two don't share cells. */
const COURT_DEPTH = 22;

export interface ShowcaseStats {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

type Place = (x: number, y: number, z: number, name: string, rotation?: Rotation) => void;

/** Builds the showcase of `library` into an empty project. */
export function buildShowcase(project: Project, library: Library): ShowcaseStats {
  const { world, semantics } = project;
  const lookOf = (name: string) => {
    const existing = semantics.byName(name);
    if (existing !== undefined) return existing;
    const block = library.blocks[name];
    return semantics.add(name, {
      look: { block: `${library.id}:${name}`, ...(block && { tint: block.color }) },
    });
  };
  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  const place: Place = (x, y, z, name, rotation = 0) => {
    world.set(x, y, z, { semantic: lookOf(name), rotation });
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };
  const has = (name: string) => library.blocks[name] !== undefined;

  const names = Object.keys(library.blocks).sort();
  // Blocks per row: a square for big libraries, and at least as wide as the court.
  const ROW = Math.max(10, Math.ceil(Math.sqrt(names.length)));
  const gridRows = Math.ceil(names.length / ROW);
  const width = Math.max(ROW * STEP + 1, 26);
  const catalogZ = COURT_DEPTH;
  const depth = catalogZ + gridRows * STEP + STEP * 2 + 4;
  const lawn = library.blocks.grass_block ? "grass_block" : names[0];
  if (lawn) {
    for (let x = -1; x < width; x++) for (let z = -1; z < depth; z++) place(x, 0, z, lawn);
  }

  buildCourt(place, has);

  names.forEach((name, i) => {
    place((i % ROW) * STEP + 1, 1, catalogZ + Math.floor(i / ROW) * STEP + 1, name);
  });
  let z = catalogZ + gridRows * STEP + 1;

  // Orientations: logs upright, lying along x and lying along z (all a log can show), stairs
  // facing each way, and upside down.
  let x = 1;
  for (const log of names.filter((n) => n.endsWith("_log")).slice(0, 2)) {
    for (const r of [0, turn(2, 1), turn(0, 1)]) {
      place(x, 1, z, log, r);
      x += 2;
    }
    x += 2;
  }
  z += STEP;
  x = 1;
  const upsideDown = rotationFacing([0, 0, -1], [0, -1, 0]);
  for (const stairs of names.filter((n) => n.endsWith("_stairs")).slice(0, 2)) {
    for (const r of [0, turnClockwise(1), turnClockwise(2), turnClockwise(3), upsideDown]) {
      place(x, 1, z, stairs, r);
      x += 2;
    }
  }

  return { min: [-1, 0, -1], max: [maxX, maxY, maxZ] };
}

function pick(has: (name: string) => boolean, ...names: string[]): string | undefined {
  return names.find((name) => has(name));
}

/**
 * A court you can walk: a gate in a wall, a fenced garden with two trees, a lamp-lit house,
 * and a glass pavilion you climb a short stair to reach. Pieces the library lacks are skipped,
 * so a jar of unfamiliar blocks still gets the catalogue.
 */
function buildCourt(place: Place, has: (name: string) => boolean): void {
  const wall = pick(has, "stone_bricks", "bricks", "stone");
  const glass = pick(has, "glass");
  const glow = pick(has, "glowstone", "sea_lantern");
  const log = pick(has, "oak_log", "spruce_log");
  const leaves = pick(has, "oak_leaves", "spruce_leaves", "azalea_leaves");
  const fence = pick(has, "oak_fence", "spruce_fence");
  const slab = pick(has, "stone_brick_slab", "oak_slab", "stone_slab");
  const stairs = pick(has, "stone_brick_stairs", "stone_stairs", "oak_stairs");
  const path = pick(has, "sandstone", "smooth_stone", "quartz_block", "stone");
  const floor = pick(has, "quartz_block", "smooth_stone", "stone_bricks");
  if (!wall) return;

  const x0 = 1;
  const x1 = 22;
  const z0 = 1;
  const z1 = 18;
  const gateX0 = 10;
  const gateX1 = 12;

  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const edge = x === x0 || x === x1 || z === z0 || z === z1;
      if (!edge) continue;
      const gate = z === z0 && x >= gateX0 && x <= gateX1;
      for (let y = 1; y <= 3; y++) {
        if (gate && y < 3) continue;
        place(x, y, z, wall);
      }
    }
  }

  if (path) {
    for (let z = z0 + 1; z <= 9; z++) {
      place(gateX0, 0, z, path);
      place(gateX0 + 1, 0, z, path);
    }
  }
  if (log && glow) {
    for (const x of [gateX0 - 2, gateX1 + 2]) {
      for (let y = 1; y <= 3; y++) place(x, y, z0 + 1, log);
      place(x, 4, z0 + 1, glow);
    }
  }

  // A raised bed with a fence and two trees, west of the path.
  if (fence) {
    for (let x = 3; x <= 7; x++) {
      place(x, 1, 4, fence);
      place(x, 1, 12, fence);
    }
    for (let z = 5; z <= 11; z++) {
      place(3, 1, z, fence);
      place(7, 1, z, fence);
    }
  }
  if (log && leaves) {
    tree(place, 5, 7, log, leaves);
    tree(place, 6, 10, log, leaves);
  }

  // A hollow house, east of the path: glass in the walls, a lamp in the dark inside.
  const hx0 = 14;
  const hx1 = 20;
  const hz0 = 4;
  const hz1 = 11;
  shell(place, hx0, hx1, 1, 4, hz0, hz1, wall, (x, y, z) => {
    const door = x === hx0 && z >= 6 && z <= 7 && y <= 2;
    const window =
      y >= 2 && y <= 3 && ((z === hz0 && x >= 16 && x <= 18) || (x === hx1 && z === 8));
    return door || window;
  });
  if (glass) {
    for (let x = 16; x <= 18; x++) for (let y = 2; y <= 3; y++) place(x, y, hz0, glass);
    place(hx1, 2, 8, glass);
    place(hx1, 3, 8, glass);
  }
  if (slab) for (let x = hx0; x <= hx1; x++) for (let z = hz0; z <= hz1; z++) place(x, 5, z, slab);
  if (glow) place(17, 1, 8, glow);
  if (floor)
    for (let x = hx0 + 1; x < hx1; x++) for (let z = hz0 + 1; z < hz1; z++) place(x, 0, z, floor);

  // A glass pavilion on a step, climbed from the path. The lamp sits under the roof.
  const px0 = 8;
  const px1 = 13;
  const pz0 = 12;
  const pz1 = 16;
  if (floor) {
    for (let x = px0; x <= px1; x++) for (let z = pz0; z <= pz1; z++) place(x, 1, z, floor);
  }
  if (stairs) {
    const up = rotationFacing([0, 0, 1], [0, 1, 0]);
    for (let x = 10; x <= 11; x++) place(x, 1, pz0 - 1, stairs, up);
  }
  if (log) {
    for (const [x, z] of [
      [px0, pz0],
      [px1, pz0],
      [px0, pz1],
      [px1, pz1],
    ] as const) {
      for (let y = 2; y <= 5; y++) place(x, y, z, log);
    }
  }
  if (glass) {
    for (let x = px0 + 1; x < px1; x++) {
      for (let y = 2; y <= 4; y++) {
        place(x, y, pz1, glass);
        if (x < 10 || x > 11) place(x, y, pz0, glass);
      }
    }
    for (let z = pz0 + 1; z < pz1; z++) {
      for (let y = 2; y <= 4; y++) {
        place(px0, y, z, glass);
        place(px1, y, z, glass);
      }
    }
  }
  if (slab) for (let x = px0; x <= px1; x++) for (let z = pz0; z <= pz1; z++) place(x, 6, z, slab);
  if (glow) place(10, 2, 14, glow);

  // A short tower at the back corner, so the court has a skyline past the walls.
  const tx0 = 1;
  const tx1 = 4;
  const tz0 = 14;
  const tz1 = 17;
  shell(place, tx0, tx1, 1, 7, tz0, tz1, wall, (x, y, z) => {
    const window = y >= 3 && y <= 4 && x === tx1 && z === 15;
    const door = z === tz0 && x === 2 && y <= 2;
    return window || door;
  });
  if (glass) {
    place(tx1, 3, 15, glass);
    place(tx1, 4, 15, glass);
  }
  if (slab) for (let x = tx0; x <= tx1; x++) for (let z = tz0; z <= tz1; z++) place(x, 8, z, slab);
  if (glow) place(2, 2, 15, glow);
}

function tree(place: Place, x: number, z: number, log: string, leaves: string): void {
  for (let y = 1; y <= 4; y++) place(x, y, z, log);
  for (let y = 4; y <= 6; y++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0 && y < 6) continue;
        if (Math.abs(dx) + Math.abs(dz) === 2 && y === 6) continue;
        place(x + dx, y, z + dz, leaves);
      }
    }
  }
}

/** The walls of a box. `open` skips a cell (a door or a window). The inside stays empty. */
function shell(
  place: Place,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  name: string,
  open: (x: number, y: number, z: number) => boolean,
): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (edge && !open(x, y, z)) place(x, y, z, name);
      }
    }
  }
}
