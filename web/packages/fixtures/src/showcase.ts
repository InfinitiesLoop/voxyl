// A sample that shows every block of a library: one semantic per block, each look naming its
// block, set out on a lawn. Oriented blocks also stand in their other orientations (logs on
// each axis, stairs facing each way and upside down), and a few groups test what textures
// must get right: glass in front of a wall, glass against glass, and a lamp in a dark room.

import type { Library } from "@voxyl/blocks";
import {
  compose,
  type Project,
  type Rotation,
  rotationFacing,
  turn,
  turnClockwise,
} from "@voxyl/core";

/** Blocks per row, and the step between them. */
const ROW = 10;
const STEP = 3;

export interface ShowcaseStats {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

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
  const place = (x: number, y: number, z: number, name: string, rotation: Rotation = 0) =>
    world.set(x, y, z, { semantic: lookOf(name), rotation });

  const names = Object.keys(library.blocks).sort();
  const rows = Math.ceil(names.length / ROW) + 4;
  const width = ROW * STEP + 1;
  const depth = rows * STEP + 1;
  const lawn = library.blocks.grass_block ? "grass_block" : names[0];
  if (lawn) {
    for (let x = -1; x < width; x++) for (let z = -1; z < depth; z++) place(x, 0, z, lawn);
  }

  names.forEach((name, i) => {
    place((i % ROW) * STEP + 1, 1, Math.floor(i / ROW) * STEP + 1, name);
  });
  let z = Math.ceil(names.length / ROW) * STEP + 1;

  // Orientations: logs lying along x and z (each spun both ways), stairs facing each way,
  // and upside down.
  const lyingX = (spin: number) => compose(turn(2, 1), turn(1, spin));
  const lyingZ = (spin: number) => compose(turn(0, 1), turn(1, spin));
  let x = 1;
  for (const log of names.filter((n) => n.endsWith("_log"))) {
    for (const r of [lyingX(0), lyingX(1), lyingZ(0), lyingZ(1)]) {
      place(x, 1, z, log, r);
      x += 2;
    }
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
  z += STEP;

  // Glass in front of a wall and against more glass; a lamp in a closed dark room.
  if (library.blocks.glass && library.blocks.stone_bricks) {
    for (let dx = 0; dx < 5; dx++)
      for (let y = 1; y <= 3; y++) {
        place(1 + dx, y, z, "stone_bricks");
        if (dx > 0 && dx < 4 && y < 3) place(1 + dx, y, z + 1, "glass");
      }
  }
  if (library.blocks.glowstone && library.blocks.stone) {
    const [x0, x1, z0, z1] = [9, 15, z - 1, z + 4];
    for (let rx = x0; rx <= x1; rx++)
      for (let rz = z0; rz <= z1; rz++)
        for (let y = 1; y <= 5; y++) {
          const wall = rx === x0 || rx === x1 || rz === z0 || rz === z1 || y === 1 || y === 5;
          // An opening on the south side to look in through.
          const door = rz === z1 && rx >= x0 + 2 && rx <= x0 + 3 && y >= 2 && y <= 3;
          if (wall && !door) place(rx, y, rz, "stone");
        }
    place(x1 - 2, 2, z0 + 2, "glowstone");
  }
  return { min: [-1, 0, -1], max: [width - 1, 6, depth - 1] };
}
