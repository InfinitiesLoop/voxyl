import {
  CellSet,
  cutPiece,
  type Direction,
  type Piece,
  Project,
  rotationFacing,
} from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { exportSchematic, planExport } from "../src/export.ts";
import { builtinIdentity, type McIdentity } from "../src/identity.ts";
import { probeSchematic } from "../src/schematica.ts";

interface Cell {
  readonly at: readonly [number, number, number];
  readonly semantic: number;
  readonly rotation?: number;
  readonly parts?: readonly { semantic: number; shape: string; slot: number }[];
}

/** A project with a few semantics (the block each look names), and a piece cut from its cells. */
function build(
  semantics: Readonly<Record<string, { block?: string; glow?: boolean }>>,
  cells: (id: (name: string) => number) => Cell[],
  options: { north?: Direction } = {},
): { piece: Piece; project: Project } {
  const project = new Project();
  if (options.north) {
    project.run({
      id: "north",
      kind: "settings",
      args: { ...project.settings, north: options.north },
    });
  }
  const ids = new Map<string, number>();
  for (const [name, look] of Object.entries(semantics)) {
    ids.set(
      name,
      project.semantics.add(name, {
        look: { ...(look.block && { block: look.block }), ...(look.glow && { glow: true }) },
      }),
    );
  }
  const id = (name: string) => {
    const found = ids.get(name);
    if (found === undefined) throw new Error(`no semantic ${name}`);
    return found;
  };
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const c of cells(id)) {
    project.world.set(c.at[0], c.at[1], c.at[2], {
      ...(c.parts ? { parts: c.parts } : { semantic: c.semantic }),
      ...(c.rotation !== undefined && { rotation: c.rotation }),
    });
    lo = lo.map((v, i) => Math.min(v, c.at[i] as number));
    hi = hi.map((v, i) => Math.max(v, c.at[i] as number));
  }
  const piece = cutPiece(
    { world: project.world, semantics: project.semantics, north: project.settings.north },
    CellSet.ofBox({ x0: lo[0]!, y0: lo[1]!, z0: lo[2]!, x1: hi[0]!, y1: hi[1]!, z1: hi[2]! }),
  );
  if (!piece) throw new Error("empty piece");
  return { piece, project };
}

const identify = builtinIdentity;

async function written(piece: Piece, options: Partial<Parameters<typeof planExport>[1]> = {}) {
  const { bytes, report } = await exportSchematic(piece, { identify, ...options });
  const probe = await probeSchematic(bytes);
  if (!probe) throw new Error("the export doesn't parse");
  return { bytes, report, probe };
}

const at = (probe: { size: readonly number[] }, x: number, y: number, z: number) =>
  (y * (probe.size[2] as number) + z) * (probe.size[0] as number) + x;

describe("whole blocks", () => {
  const sems = {
    Base: { block: "voxyl:stone" },
    Floor: { block: "voxyl:oak_planks" },
    Roof: { block: "voxyl:oak_slab" },
  };

  it("writes Schematica's structure: a golden check of a small build", async () => {
    const { piece } = build(sems, (id) => [
      { at: [0, 0, 0], semantic: id("Base") },
      { at: [1, 0, 0], semantic: id("Floor") },
      { at: [0, 0, 1], semantic: id("Base") },
      // An upside-down slab: up points down.
      { at: [1, 1, 1], semantic: id("Roof"), rotation: rotationFacing([0, 0, -1], [0, -1, 0]) },
    ]);
    const { probe, report } = await written(piece);

    expect(probe.size).toEqual([2, 2, 2]);
    expect(Object.keys(probe.root)).toEqual([
      "Width",
      "Height",
      "Length",
      "Materials",
      "Blocks",
      "Data",
      "Entities",
      "TileEntities",
      "SchematicaMapping",
      "BlockMapping",
      "ItemMapping",
    ]);
    expect(probe.root.Materials).toEqual({ type: "string", value: "Alpha" });
    expect(probe.root.Width?.type).toBe("short");
    expect(probe.root.Entities).toEqual({ type: "list", itemType: "compound", items: [] });
    expect(probe.root.ItemMapping).toEqual({ type: "compound", value: {} });

    // Vanilla ids fit the byte and are used as they are: stone 1, planks 5, stone_slab 44.
    expect(probe.mapping).toEqual({
      "minecraft:stone": 1,
      "minecraft:planks": 5,
      "minecraft:wooden_slab": 126,
    });
    expect(probe.root.BlockMapping).toEqual(probe.root.SchematicaMapping);

    // (y * length + z) * width + x
    expect(probe.ids[at(probe, 0, 0, 0)]).toBe(1);
    expect(probe.ids[at(probe, 1, 0, 0)]).toBe(5);
    expect(probe.ids[at(probe, 0, 0, 1)]).toBe(1);
    expect(probe.ids[at(probe, 1, 0, 1)]).toBe(0);
    expect(probe.ids[at(probe, 1, 1, 1)]).toBe(126);
    expect(probe.metas[at(probe, 1, 1, 1)]).toBe(8); // oak slab, top half
    expect(probe.metas[at(probe, 1, 0, 0)]).toBe(0);
    expect(probe.histogram).toEqual({
      "minecraft:stone": 2,
      "minecraft:planks": 1,
      "minecraft:wooden_slab": 1,
    });

    expect(report.cellsWritten).toBe(4);
    expect(report.distinctBlocks).toBe(3);
    expect(report.mapped["minecraft:stone"]).toBe(2);
    expect(report.turnedDegrees).toBe(0);
    expect(report.problem).toBeNull();
  });

  it("sets stairs and log metadata from the cell's rotation", async () => {
    const east = rotationFacing([1, 0, 0], [0, 1, 0]);
    const northUpsideDown = rotationFacing([0, 0, -1], [0, -1, 0]);
    const south = rotationFacing([0, 0, 1], [0, 1, 0]);
    const lyingEastWest = rotationFacing([0, 0, -1], [1, 0, 0]);
    const lyingNorthSouth = rotationFacing([1, 0, 0], [0, 0, 1]);
    const { piece } = build(
      { Step: { block: "voxyl:oak_stairs" }, Beam: { block: "voxyl:spruce_log" } },
      (id) => [
        { at: [0, 0, 0], semantic: id("Step"), rotation: east },
        { at: [1, 0, 0], semantic: id("Step"), rotation: northUpsideDown },
        { at: [2, 0, 0], semantic: id("Step"), rotation: south },
        { at: [3, 0, 0], semantic: id("Beam"), rotation: lyingEastWest },
        { at: [4, 0, 0], semantic: id("Beam"), rotation: lyingNorthSouth },
        { at: [5, 0, 0], semantic: id("Beam") },
      ],
    );
    const { probe } = await written(piece);
    const metas = [0, 1, 2, 3, 4, 5].map((x) => probe.metas[at(probe, x, 0, 0)]);
    // Stairs: east 0, north 3 + upside-down 4, south 2. Spruce log (1): east-west 4, north-south 8.
    expect(metas).toEqual([0, 7, 2, 1 | 4, 1 | 8, 1]);
  });

  it("leaves undecided and unidentified blocks as air and says so", async () => {
    const { piece } = build(
      {
        Stone: { block: "voxyl:stone" },
        Mass: {},
        Odd: { block: "somemod:thing" },
      },
      (id) => [
        { at: [0, 0, 0], semantic: id("Stone") },
        { at: [1, 0, 0], semantic: id("Mass") },
        { at: [2, 0, 0], semantic: id("Mass") },
        { at: [3, 0, 0], semantic: id("Odd") },
      ],
    );
    const { probe, report } = await written(piece);
    expect(probe.size).toEqual([4, 1, 1]);
    expect([0, 1, 2, 3].map((x) => probe.ids[x])).toEqual([1, 0, 0, 0]);
    expect(report.undecided).toEqual({ Mass: 2 });
    expect(report.unmapped).toEqual({ Odd: 1 });
    expect(report.cellsWritten).toBe(1);
    expect(report.cellsKept).toBe(4);
  });

  it("takes a block's own identity before the built-in table, and flags assumed ones", () => {
    const { piece } = build(
      { Wall: { block: "ztones:korp" }, Pale: { block: "voxyl:white_concrete" } },
      (id) => [
        { at: [0, 0, 0], semantic: id("Wall") },
        { at: [1, 0, 0], semantic: id("Pale") },
      ],
    );
    const own: McIdentity = { registry: "Ztones:tile.korpBlock", meta: 3, legacyId: 2000 };
    const plan = planExport(piece, {
      identify: (ref) => (ref === "ztones:korp" ? own : builtinIdentity(ref)),
      dryRun: true,
    });
    expect(plan.report.mapped).toEqual({ "Ztones:tile.korpBlock": 1, "etfuturum:concrete": 1 });
    // The id doesn't fit a byte, so it counts down from 255 instead.
    expect(plan.report.assumed).toEqual({ Pale: 1 });
  });
});

describe("local ids", () => {
  it("counts down from 255 for ids that aren't a vanilla byte, and spills into AddBlocks past that", async () => {
    const names = Array.from({ length: 260 }, (_, i) => `S${i}`);
    const { piece } = build(
      Object.fromEntries(names.map((n) => [n, { block: `mod:${n}` }])),
      (id) => names.map((n, i) => ({ at: [i, 0, 0] as const, semantic: id(n) })),
    );
    const identities = (ref: string): McIdentity => ({ registry: `mod:${ref.slice(4)}` });
    const { probe, report } = await written(piece, { identify: identities });
    expect(report.distinctBlocks).toBe(260);
    expect(Object.values(probe.mapping).sort((a, b) => a - b)[0]).toBe(1);
    expect(Math.max(...Object.values(probe.mapping))).toBe(260);
    expect(probe.root.AddBlocks?.type).toBe("byteArray");
    // The first block took 255 and the 255th took 1; the last five go past the byte.
    expect(probe.mapping["mod:S0"]).toBe(255);
    expect(probe.mapping["mod:S254"]).toBe(1);
    expect(probe.mapping["mod:S255"]).toBe(256);
    for (let i = 0; i < 260; i++) {
      expect(probe.ids[i]).toBe(probe.mapping[`mod:S${i}`]);
    }
    expect(probe.histogram["mod:S259"]).toBe(1);
  });
});

describe("include, exclude and trim", () => {
  const sems = { Floor: { block: "voxyl:stone" }, Post: { block: "voxyl:oak_planks" } };
  const cells = (id: (n: string) => number): Cell[] => [
    { at: [0, 0, 0], semantic: id("Floor") },
    { at: [1, 0, 0], semantic: id("Floor") },
    { at: [1, 1, 0], semantic: id("Post") },
    { at: [1, 2, 0], semantic: id("Post") },
  ];

  it("leaves out an unticked semantic, and shrinks the box to what's left on request", async () => {
    const { piece } = build(sems, cells);
    const floor = piece.semantics.findIndex((s) => s.name === "Floor") + 1;

    const loose = await written(piece, { exclude: new Set([floor]) });
    expect(loose.probe.size).toEqual([2, 3, 1]);
    expect(loose.report.cellsExcluded).toBe(2);
    expect(loose.probe.ids[at(loose.probe, 1, 1, 0)]).toBe(5);

    const trimmed = await written(piece, { exclude: new Set([floor]), trim: true });
    expect(trimmed.probe.size).toEqual([1, 2, 1]);
    expect(trimmed.probe.histogram).toEqual({ "minecraft:planks": 2 });
    expect(trimmed.report.size).toEqual([1, 2, 1]);
  });

  it("a dry run reports exactly what the file would hold", async () => {
    const { piece } = build(sems, cells);
    const post = piece.semantics.findIndex((s) => s.name === "Post") + 1;
    const options = { identify, exclude: new Set([post]), trim: true };
    const dry = planExport(piece, { ...options, dryRun: true });
    const real = await exportSchematic(piece, options);
    expect(dry.data).toBeNull();
    expect(dry.report).toEqual(real.report);
  });

  it("says when nothing is left, or the box is too big", () => {
    const { piece } = build(sems, cells);
    const all = new Set([1, 2]);
    expect(planExport(piece, { identify, exclude: all, dryRun: true }).report.problem).toMatch(
      /nothing is left/i,
    );
    const wide: Piece = { ...piece, size: [40000, 1, 1], cells: [1, 1] };
    expect(planExport(wide, { identify, dryRun: true }).report.problem).toMatch(/at most 32767/);
    const huge: Piece = { ...piece, size: [5000, 5000, 20], cells: [1, 1] };
    expect(planExport(huge, { identify, dryRun: true }).report.problem).toMatch(
      /cells; a schematic/,
    );
  });
});

describe("north is north", () => {
  it("turns a build whose north is east so that it faces -Z", async () => {
    // +X is this project's north: the marker at the east end of the bar is its northmost.
    const { piece } = build(
      { Bar: { block: "voxyl:stone" }, Marker: { block: "voxyl:gravel" } },
      (id) => [
        { at: [0, 0, 0], semantic: id("Bar") },
        { at: [1, 0, 0], semantic: id("Bar") },
        { at: [2, 0, 0], semantic: id("Marker") },
      ],
      { north: "east" },
    );
    const { probe, report } = await written(piece);
    expect(report.turnedDegrees).toBe(270);
    expect(report.north).toBe("east");
    // A bar along x becomes a bar along z, the marker at the north (z = 0) end.
    expect(probe.size).toEqual([1, 1, 3]);
    expect([0, 1, 2].map((z) => probe.ids[at(probe, 0, 0, z)])).toEqual([13, 1, 1]);
  });

  it("leaves a build that already faces north alone, and turns by a given amount", async () => {
    const { piece } = build({ Bar: { block: "voxyl:stone" } }, (id) => [
      { at: [0, 0, 0], semantic: id("Bar") },
      { at: [1, 0, 0], semantic: id("Bar") },
    ]);
    expect((await written(piece)).report.turnedDegrees).toBe(0);
    const turned = await written(piece, { turns: 1 });
    expect(turned.probe.size).toEqual([1, 1, 2]);
  });

  it("turns a stair's facing and a part's slot with the build", async () => {
    const east = rotationFacing([1, 0, 0], [0, 1, 0]);
    const { piece } = build(
      { Step: { block: "voxyl:oak_stairs" }, Cover: { block: "voxyl:stone" } },
      (id) => [
        { at: [0, 0, 0], semantic: id("Step"), rotation: east },
        {
          at: [1, 0, 0],
          semantic: 0,
          parts: [{ semantic: id("Cover"), shape: "face1", slot: 5 }], // against the east side
        },
      ],
      { north: "east" },
    );
    const { probe } = await written(piece);
    // East is this build's north: stairs facing east now face north (3), the cover is on the north side (slot 2).
    expect(probe.metas[at(probe, 0, 0, 1)]).toBe(3);
    const tile = probe.tileEntities[0];
    expect(tile?.z).toEqual({ type: "int", value: 0 });
    const part = (
      tile?.parts as unknown as { items: Record<string, { value: unknown }>[] } | undefined
    )?.items[0];
    expect(part?.shape?.value).toBe((1 << 4) | 2);
  });
});

describe("shaped parts", () => {
  it("writes ForgeMultipart tiles for microblocks, material keys and all", async () => {
    const { piece } = build(
      {
        Trim: { block: "voxyl:stone" },
        Slab: { block: "voxyl:stone_slab" },
      },
      (id) => [
        {
          at: [0, 0, 0],
          semantic: 0,
          parts: [
            { semantic: id("Trim"), shape: "edge2", slot: 12 }, // a centred post along Y
            { semantic: id("Slab"), shape: "face4", slot: 1 },
          ],
        },
        { at: [1, 0, 0], semantic: id("Trim") },
      ],
    );
    const { probe, report } = await written(piece);
    expect(probe.mapping["ForgeMultipart:block"]).toBeDefined();
    expect(probe.histogram["ForgeMultipart:block"]).toBe(1);
    expect(report.tileEntities).toBe(1);
    expect(probe.tileEntities).toHaveLength(1);
    const tile = probe.tileEntities[0] as Record<
      string,
      { type: string; value?: unknown; items?: unknown[] }
    >;
    expect(tile.id).toEqual({ type: "string", value: "savedMultipart" });
    expect([tile.x?.value, tile.y?.value, tile.z?.value]).toEqual([0, 0, 0]);
    const parts = tile.parts?.items as Record<string, { value: unknown }>[];
    expect(parts.map((p) => [p.id?.value, p.shape?.value, p.material?.value])).toEqual([
      ["mcr_post", (2 << 4) | 0, "minecraft:stone"],
      ["mcr_face", (4 << 4) | 1, "minecraft:stone_slab"],
    ]);
  });

  it("appends the metadata to a microblock's material", async () => {
    const { piece } = build({ Wood: { block: "voxyl:spruce_planks" } }, (id) => [
      { at: [0, 0, 0], semantic: 0, parts: [{ semantic: id("Wood"), shape: "corner1", slot: 7 }] },
    ]);
    const { probe } = await written(piece);
    const part = (
      probe.tileEntities[0]?.parts as unknown as
        | { items: Record<string, { value: unknown }>[] }
        | undefined
    )?.items[0];
    expect(part?.id?.value).toBe("mcr_cnr");
    expect(part?.material?.value).toBe("minecraft:planks_1");
  });

  it("writes an ArchitectureCraft tile for a roof shape, in the glow block when it glows", async () => {
    const { piece } = build(
      { Tiles: { block: "voxyl:bricks" }, Lamp: { block: "voxyl:bricks", glow: true } },
      (id) => [
        {
          at: [0, 0, 0],
          semantic: 0,
          parts: [{ semantic: id("Tiles"), shape: "roof_ridge", slot: 9 }],
        },
        {
          at: [1, 0, 0],
          semantic: 0,
          parts: [{ semantic: id("Lamp"), shape: "roof_tile", slot: 0 }],
        },
      ],
    );
    const { probe, report } = await written(piece);
    expect(probe.histogram).toEqual({
      "ArchitectureCraft:shape": 1,
      "ArchitectureCraft:shapeSE": 1,
    });
    expect(report.tileEntities).toBe(2);
    const ridge = probe.tileEntities.find((t) => (t.x as { value: number }).value === 0) as Record<
      string,
      { value: unknown }
    >;
    expect(ridge.id?.value).toBe("gcewing.shape");
    expect(ridge.Shape?.value).toBe(3);
    expect(ridge.side?.value).toBe(2); // slot 9 = side 2, turn 1
    expect(ridge.turn?.value).toBe(1);
    expect(ridge.BaseName?.value).toBe("minecraft:brick_block");
    expect(ridge.BaseData?.value).toBe(0);
  });

  it("reports parts whose block can't be written, and a part cell where nothing was", async () => {
    const { piece } = build({ Mass: {} }, (id) => [
      { at: [0, 0, 0], semantic: 0, parts: [{ semantic: id("Mass"), shape: "face1", slot: 0 }] },
    ]);
    const { report } = await exportOrProblem(piece);
    expect(report.undecided).toEqual({ Mass: 1 });
    expect(report.emptyPartCells).toBe(1);
    expect(report.cellsWritten).toBe(0);
  });
});

async function exportOrProblem(piece: Piece) {
  return { report: planExport(piece, { identify, dryRun: true }).report };
}
