import { World } from "@voxyl/core";
import { generateCity } from "@voxyl/fixtures";

export type WorldKind = "pillar" | "city-1m" | "city-5m" | "city-20m";

export const WORLD_KINDS: readonly { kind: WorldKind; label: string }[] = [
  { kind: "pillar", label: "Demo pillar" },
  { kind: "city-1m", label: "City, 1M cells" },
  { kind: "city-5m", label: "City, 5M cells" },
  { kind: "city-20m", label: "City, 20M cells" },
];

export const CHUNK_SIZES = [16, 32, 64] as const;

export interface BuiltWorld {
  readonly world: World;
  /** Horizontal centre and size, for framing the camera and the bench's flight path. */
  readonly center: readonly [number, number, number];
  readonly extent: number;
  readonly top: number;
  readonly generateMs: number;
}

const CITY_TARGETS: Record<Exclude<WorldKind, "pillar">, number> = {
  "city-1m": 1_000_000,
  "city-5m": 5_000_000,
  "city-20m": 20_000_000,
};

export function buildWorld(kind: WorldKind, chunkSize: number): BuiltWorld {
  const world = new World({ chunkBits: Math.log2(chunkSize) });
  const start = performance.now();
  if (kind === "pillar") {
    buildPillar(world);
    return { world, center: [0, 8, 0], extent: 16, top: 17, generateMs: performance.now() - start };
  }
  const stats = generateCity(world, { targetCells: CITY_TARGETS[kind], seed: 1 });
  const generateMs = performance.now() - start;
  const center = [
    (stats.min[0] + stats.max[0] + 1) / 2,
    0,
    (stats.min[2] + stats.max[2] + 1) / 2,
  ] as const;
  return { world, center, extent: stats.max[0] - stats.min[0] + 1, top: stats.max[1], generateMs };
}

/** A small pillar: a hollow dark shaft with light bands every fourth layer and glowing corners. */
function buildPillar(world: World): void {
  const half = 4;
  for (let y = 0; y < 17; y++) {
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        if (Math.abs(x) !== half && Math.abs(z) !== half) continue;
        const corner = Math.abs(x) === half && Math.abs(z) === half;
        world.set(x, y, z, { semantic: y % 4 === 0 ? "Trim" : corner ? "Glow" : "Mass" });
      }
    }
  }
}
