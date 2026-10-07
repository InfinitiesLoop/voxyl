import { DEFAULT_LIBRARY_ID, defaultLibrary } from "@voxyl/blocks";
import { Project } from "@voxyl/core";
import { CITY_THEMES, cityThemePalette, generateCity, prepareCityProject } from "@voxyl/fixtures";
import { describe, expect, it } from "vitest";
import {
  BlockMaterials,
  FACE_SLOTS,
  MATERIAL_FLOATS,
  MemoryFolder,
  ProjectStore,
  stateLooks,
  TEXTURE_SIZE,
} from "../src/index.ts";

function city(name: string, cells = 30_000): Project {
  const project = new Project({ chunkBits: 5 });
  prepareCityProject(project);
  generateCity(project, { targetCells: cells, seed: 3 });
  project.run({
    id: "name",
    kind: "settings",
    args: { name, north: "north", grid: [0, 0] },
  });
  return project;
}

/** Every occupied cell as "x,y,z:state", states written out so ids may differ. */
function cellsOf(project: Project): string[] {
  const out: string[] = [];
  project.world.forEachCell((x, y, z, id) => {
    out.push(`${x},${y},${z}:${JSON.stringify(project.world.states.get(id))}`);
  });
  return out.sort();
}

describe("ProjectStore", () => {
  it("saves, lists and opens projects losslessly", async () => {
    const store = new ProjectStore(new MemoryFolder());
    const a = city("Alpha");
    const entry = await store.save(a, 1000);
    expect(entry).toMatchObject({ id: a.id, name: "Alpha", cells: a.world.cellCount });
    const opened = await store.open(a.id, { chunkBits: 6 });
    expect(opened.id).toBe(a.id);
    expect(opened.settings.name).toBe("Alpha");
    expect(cellsOf(opened)).toEqual(cellsOf(a));
    expect(opened.semantics.toJSON()).toEqual(a.semantics.toJSON());
    await store.save(city("Beta", 10_000), 2000);
    expect((await store.list()).map((e) => e.name)).toEqual(["Beta", "Alpha"]);
  });

  it("writes only new blobs, and shares them between projects", async () => {
    const folder = new MemoryFolder();
    const store = new ProjectStore(folder);
    const a = city("Alpha");
    await store.save(a, 1);
    const blobs = () => [...folder.files.keys()].filter((k) => k.startsWith("blobs/"));
    const first = blobs().length;
    const writes: string[] = [];
    const write = folder.write.bind(folder);
    folder.write = async (path, data) => {
      writes.push(path);
      return write(path, data);
    };
    // A re-skin changes looks, not cells: no chunk blob is written again.
    a.run({ id: "skin", kind: "palette_sync", args: cityThemePalette(CITY_THEMES[1] as never, 2) });
    await store.save(a, 2);
    expect(writes.filter((p) => p.startsWith("blobs/"))).toEqual([]);
    // One cell changes: at most one storage chunk is new.
    writes.length = 0;
    a.run({
      id: "fill",
      kind: "fill",
      args: { where: { box: [0, 120, 0, 0, 120, 0] }, state: { semantic: 1 } },
    });
    await store.save(a, 3);
    expect(writes.filter((p) => p.startsWith("blobs/")).length).toBeLessThanOrEqual(1);
    expect(blobs().length).toBeGreaterThanOrEqual(first);
  });

  it("deletes a project and only the blobs nothing else uses", async () => {
    const folder = new MemoryFolder();
    const store = new ProjectStore(folder);
    const a = city("Alpha");
    const b = city("Beta", 10_000);
    await store.save(a, 1);
    await store.save(b, 2);
    await store.delete(a.id);
    expect((await store.list()).map((e) => e.name)).toEqual(["Beta"]);
    const opened = await store.open(b.id);
    expect(cellsOf(opened)).toEqual(cellsOf(b));
    await store.delete(b.id);
    expect([...folder.files.keys()]).toEqual([]);
  });

  it("imports a bundle, as a copy when the id is taken", async () => {
    const store = new ProjectStore(new MemoryFolder());
    const a = city("Alpha");
    await store.save(a, 1);
    const bundle = await store.exportBundle(a.id);
    const elsewhere = new ProjectStore(new MemoryFolder());
    expect((await elsewhere.importBundle(bundle, 5)).id).toBe(a.id);
    const copy = await store.importBundle(bundle, 6);
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).toBe("Alpha");
    expect(cellsOf(await store.open(copy.id))).toEqual(cellsOf(a));
    expect(await store.list()).toHaveLength(2);
  });

  it("refuses ids that aren't file names", async () => {
    const store = new ProjectStore(new MemoryFolder());
    await expect(store.open("../x")).rejects.toThrow(/Not a project id/);
  });
});

describe("stateLooks", () => {
  it("colours states by their resolved looks, and a theme sync recolours them", () => {
    const project = city("Alpha", 5_000);
    const states = project.world.states;
    const glow = project.semantics.byName("Glow", 1) as number;
    const glowState = states.intern({ semantic: glow });
    const before = stateLooks(states, project.semantics);
    expect(before.colors[glowState * 4 + 3]).toBe(1);
    expect(before.materials.emission[glowState]).toBeGreaterThan(0);
    project.run({
      id: "skin",
      kind: "palette_sync",
      args: cityThemePalette(CITY_THEMES[2] as never, 2),
    });
    const after = stateLooks(states, project.semantics);
    // Undecided: no glow, the undecided grey.
    expect(after.colors[glowState * 4 + 3]).toBe(0);
    expect([...after.colors.subarray(glowState * 4, glowState * 4 + 3)]).toEqual([
      0x8a, 0x8f, 0x98,
    ]);
  });
});

describe("stateLooks with blocks", () => {
  const blocks = () => new BlockMaterials(new Map([[DEFAULT_LIBRARY_ID, defaultLibrary()]]));
  const blocksTheme = CITY_THEMES.findIndex((t) => t.name === "Blocks");

  it("textures whole cubes from the default library, and lets light through glass", () => {
    const project = city("Alpha", 5_000);
    project.run({
      id: "skin",
      kind: "palette_sync",
      args: cityThemePalette(CITY_THEMES[blocksTheme] as never, 2),
    });
    const states = project.world.states;
    const stateOf = (name: string) =>
      states.intern({ semantic: project.semantics.byName(name, 1) as number });
    const mass = stateOf("Mass");
    const glass = stateOf("Glass");
    const glow = stateOf("Glow");
    const materials = blocks();
    const looks = stateLooks(states, project.semantics, materials);
    // Every face of the stone bricks is textured; the colour is the texture's average.
    for (let f = 0; f < 6; f++) expect(looks.faces[mass * FACE_SLOTS + f]).toBeGreaterThan(0);
    expect(looks.materials.opaque[mass]).toBe(1);
    expect(looks.clear[mass]).toBe(0);
    expect(looks.materials.opaque[glass]).toBe(0);
    expect(looks.clear[glass]).toBe(1);
    expect(looks.materials.emission[glow]).toBeGreaterThan(0);
    const { from, rgba } = materials.takeTextures();
    expect(from).toBe(0);
    expect(rgba.length).toBe(materials.layerCount * TEXTURE_SIZE * TEXTURE_SIZE * 4);
    expect(materials.data.length % MATERIAL_FLOATS).toBe(0);
    // Asking again adds nothing new.
    stateLooks(states, project.semantics, materials);
    expect(materials.takeTextures().rgba.length).toBe(0);
  });

  it("draws looks without blocks, or with blocks no library has, in their tint", () => {
    const project = city("Alpha", 5_000);
    const states = project.world.states;
    const mass = states.intern({ semantic: project.semantics.byName("Mass", 1) as number });
    const looks = stateLooks(states, project.semantics, blocks());
    expect(looks.faces.every((m) => m === 0)).toBe(true);
    expect([...looks.colors.subarray(mass * 4, mass * 4 + 3)]).toEqual([0x3b, 0x40, 0x48]);
  });
});
