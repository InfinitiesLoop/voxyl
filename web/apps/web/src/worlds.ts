import { DEFAULT_LIBRARY_ID, type Libraries } from "@voxyl/blocks";
import { chunkKeyToCoords, type Direction, Project } from "@voxyl/core";
import {
  buildShowcase,
  CITY_THEMES,
  type CityTheme,
  generateCity,
  prepareCityProject,
} from "@voxyl/fixtures";
import { MINECRAFT_LIBRARY_ID } from "@voxyl/mc-import";

export type WorldKind =
  | "pillar"
  | "blocks"
  | "mc-blocks"
  | "city-1m"
  | "city-5m"
  | "city-20m"
  | "parts-1m"
  | "parts-5m"
  | "parts-20m";

export const WORLD_KINDS: readonly { kind: WorldKind; label: string }[] = [
  { kind: "pillar", label: "Demo pillar" },
  { kind: "blocks", label: "Block showcase" },
  { kind: "mc-blocks", label: "Minecraft block showcase" },
  { kind: "city-1m", label: "City, 1M cells" },
  { kind: "city-5m", label: "City, 5M cells" },
  { kind: "city-20m", label: "City, 20M cells" },
  { kind: "parts-1m", label: "Shaped city, 1M cells" },
  { kind: "parts-5m", label: "Shaped city, 5M cells" },
  { kind: "parts-20m", label: "Shaped city, 20M cells" },
];

/** Runtime mesh chunks. 64³ measured as the best single size, so it isn't a setting. */
export const CHUNK_SIZE = 64;

/**
 * What to show: a generated sample (its WorldKind) or a saved project, written "saved:<id>".
 * Kept as one string so it fits a select and the URL.
 */
export type WorldSource = string;

const SAVED = "saved:";

export const savedSource = (id: string): WorldSource => `${SAVED}${id}`;

/** The saved project's id, or null for a sample. */
export function savedId(source: WorldSource): string | null {
  return source.startsWith(SAVED) ? source.slice(SAVED.length) : null;
}

export function sampleKind(source: WorldSource): WorldKind | null {
  return WORLD_KINDS.find((w) => w.kind === source)?.kind ?? null;
}

/** What the main thread knows about a world built in the world worker. */
export interface WorldInfo {
  readonly name: string;
  /** The id it is saved under, or null for a sample not saved yet. */
  readonly saved: string | null;
  readonly chunkSize: number;
  /** Horizontal centre and size, for framing the camera and the bench's flight path. */
  readonly center: readonly [number, number, number];
  readonly extent: number;
  readonly top: number;
  /** Which of its directions is real north, and its major grid offset (project settings). */
  readonly north: Direction;
  readonly grid: readonly [number, number];
  /** Which city theme it shows (CITY_THEMES), or null for a project without one. */
  readonly theme: number | null;
  /** Time to generate or open it. */
  readonly loadMs: number;
}

export interface Framing {
  readonly center: readonly [number, number, number];
  readonly extent: number;
  readonly top: number;
}

const CITY_TARGETS: Record<Exclude<WorldKind, "pillar" | "blocks" | "mc-blocks">, number> = {
  "city-1m": 1_000_000,
  "city-5m": 5_000_000,
  "city-20m": 20_000_000,
  "parts-1m": 1_000_000,
  "parts-5m": 5_000_000,
  "parts-20m": 20_000_000,
};

/** The theme at `index`, or the first one when out of range. */
export function themeAt(index: number): CityTheme {
  return CITY_THEMES[index] ?? (CITY_THEMES[0] as CityTheme);
}

/**
 * Generates a sample build, its looks coming from a linked city theme (see
 * prepareCityProject), and how to frame it.
 */
export function buildSample(
  kind: WorldKind,
  chunkSize: number,
  theme: CityTheme,
  libraries: Libraries,
): { project: Project; framing: Framing } {
  const project = new Project({ chunkBits: Math.log2(chunkSize) });
  const label = WORLD_KINDS.find((w) => w.kind === kind)?.label ?? kind;
  project.run({ id: "name", kind: "settings", args: { ...project.settings, name: label } });
  if (kind === "blocks" || kind === "mc-blocks") {
    // Looks of its own, one per block: no city theme.
    const id = kind === "blocks" ? DEFAULT_LIBRARY_ID : MINECRAFT_LIBRARY_ID;
    const library = libraries.get(id);
    if (!library) throw new Error("Import a Minecraft jar first (Minecraft jar… below)");
    const { min, max } = buildShowcase(project, library);
    const center = [(min[0] + max[0] + 1) / 2, 0, (min[2] + max[2] + 1) / 2] as const;
    const extent = Math.max(max[0] - min[0], max[2] - min[2]) + 1;
    return { project, framing: { center, extent, top: max[1] } };
  }
  const parts = kind.startsWith("parts-");
  prepareCityProject(project, theme, parts);
  if (kind === "pillar") {
    buildPillar(project);
    return { project, framing: { center: [0, 8, 0], extent: 16, top: 17 } };
  }
  const stats = generateCity(project, {
    targetCells: CITY_TARGETS[kind],
    seed: 1,
    parts,
  });
  const center = [
    (stats.min[0] + stats.max[0] + 1) / 2,
    0,
    (stats.min[2] + stats.max[2] + 1) / 2,
  ] as const;
  const extent = stats.max[0] - stats.min[0] + 1;
  return { project, framing: { center, extent, top: stats.max[1] } };
}

/** Above this many cells, framing uses whole chunks rather than visiting every cell. */
const EXACT_FRAMING_CELLS = 4_000_000;

/**
 * A project's bounds as cell corners (min inclusive, max exclusive): exact, or the chunks it
 * occupies when it is huge. Null for an empty project.
 */
export function projectBounds(
  project: Project,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const world = project.world;
  const size = world.layout.size;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  if (world.cellCount <= EXACT_FRAMING_CELLS) {
    world.forEachCell((x, y, z) => {
      if (x < (lo[0] as number)) lo[0] = x;
      if (y < (lo[1] as number)) lo[1] = y;
      if (z < (lo[2] as number)) lo[2] = z;
      if (x + 1 > (hi[0] as number)) hi[0] = x + 1;
      if (y + 1 > (hi[1] as number)) hi[1] = y + 1;
      if (z + 1 > (hi[2] as number)) hi[2] = z + 1;
    });
  } else {
    for (const key of world.chunkKeys()) {
      const c = chunkKeyToCoords(key);
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a] as number, (c[a] as number) * size);
        hi[a] = Math.max(hi[a] as number, ((c[a] as number) + 1) * size);
      }
    }
  }
  if (lo[0] === Infinity) return null;
  return { min: lo as [number, number, number], max: hi as [number, number, number] };
}

/** Framing for any project: its exact bounds, or the chunks it occupies when it is huge. */
export function frameProject(project: Project): Framing {
  const bounds = projectBounds(project);
  if (!bounds) return { center: [0, 0, 0], extent: 16, top: 0 };
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  return {
    center: [(x0 + x1) / 2, Math.max(0, y0), (z0 + z1) / 2],
    extent: Math.max(x1 - x0, z1 - z0),
    top: y1,
  };
}

/** A small pillar: a hollow dark shaft with light bands every fourth layer and glowing corners. */
function buildPillar({ world, semantics }: Project): void {
  const trim = semantics.ensure("Trim");
  const glow = semantics.ensure("Glow");
  const mass = semantics.ensure("Mass");
  const half = 4;
  for (let y = 0; y < 17; y++) {
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        if (Math.abs(x) !== half && Math.abs(z) !== half) continue;
        const corner = Math.abs(x) === half && Math.abs(z) === half;
        world.set(x, y, z, { semantic: y % 4 === 0 ? trim : corner ? glow : mass });
      }
    }
  }
}
