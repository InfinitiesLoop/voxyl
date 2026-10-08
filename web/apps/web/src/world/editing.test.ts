import { defaultLibrary, profileOfBlock } from "@voxyl/blocks";
import { EMPTY_ID, facingOf, PLACEMENTS, ROOT_PALETTE, sideOf, upOf } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  type Aim,
  addPaletteCommand,
  addSemanticCommand,
  aim,
  describeSemanticCommand,
  editSemanticCommand,
  eraseCommand,
  fillBoxCommand,
  historyState,
  linkPaletteCommand,
  newProject,
  paletteInfo,
  partGhost,
  placeCommand,
  renameCommand,
  renameSemanticCommand,
  STARTER_SEMANTICS,
  setCellCommand,
  setLookCommand,
  settingsCommand,
  sharedFromPalette,
  stepCommand,
} from "./editing.ts";

const wall = (project: ReturnType<typeof newProject>) => project.semantics.byName("Wall") as number;

describe("aim", () => {
  it("rests on the ground plane in an empty world", () => {
    const project = newProject("Test", 5);
    const target = aim(project.world, [0.5, 10, 0.5], [0, -1, 0.5], 100);
    expect(target).toMatchObject({ hit: null, place: [0, 0, 5], face: [0, 1, 0] });
  });

  it("misses when looking up, or the ground is out of reach", () => {
    const project = newProject("Test", 5);
    expect(aim(project.world, [0, 10, 0], [0, 1, 0], 100)).toBeNull();
    expect(aim(project.world, [0, 10, 0], [0, -1, 1], 5)).toBeNull();
  });

  it("hits a block and places against the face it entered", () => {
    const project = newProject("Test", 5);
    const id = project.world.states.intern({ semantic: wall(project) });
    project.world.setId(3, 0, 3, id);
    const target = aim(project.world, [3.5, 0.75, 10], [0, 0, -1], 100);
    expect(target).toMatchObject({ hit: [3, 0, 3], id, place: [3, 0, 4], face: [0, 0, 1] });
    expect(target?.hitY).toBeCloseTo(0.75);
  });
});

describe("edit commands", () => {
  it("places, removes, undoes and redoes, with labels", () => {
    const project = newProject("Test", 5);
    const ground = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!ground) throw new Error("no aim");
    const place = placeCommand(project, ground, wall(project), [0, -1, 0]);
    if (!place) throw new Error("no command");
    project.run(place);
    expect(project.world.get(0, 0, 0)?.semantic).toBe(wall(project));
    expect(historyState(project)).toEqual({ undo: "Place Wall", redo: null });

    const onIt = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!onIt) throw new Error("no aim");
    expect(onIt.hit).toEqual([0, 0, 0]);
    project.run(eraseCommand(project, onIt) as never);
    expect(project.world.getId(0, 0, 0)).toBe(EMPTY_ID);
    expect(historyState(project).undo).toBe("Remove Wall");

    project.run(stepCommand(project, "undo") as never);
    expect(project.world.get(0, 0, 0)?.semantic).toBe(wall(project));
    expect(historyState(project)).toEqual({ undo: "Place Wall", redo: "Remove Wall" });
    project.run(stepCommand(project, "redo") as never);
    expect(project.world.getId(0, 0, 0)).toBe(EMPTY_ID);
  });

  it("will not place into a cell that is already full", () => {
    const project = newProject("Test", 5);
    const id = project.world.states.intern({ semantic: wall(project) });
    project.world.setId(1, 0, 0, id);
    const blocked: Aim = {
      hit: [0, 0, 0],
      id: EMPTY_ID,
      place: [1, 0, 0],
      face: [1, 0, 0],
      hitY: 0.5,
    };
    expect(placeCommand(project, blocked, wall(project), [1, 0, 0])).toBeNull();
  });

  it("renames through a settings command, and ignores a blank or unchanged name", () => {
    const project = newProject("Test", 5);
    expect(renameCommand(project, "  ")).toBeNull();
    expect(renameCommand(project, "Test")).toBeNull();
    const command = renameCommand(project, "  Tower ");
    if (!command) throw new Error("no command");
    project.run(command);
    expect(project.settings.name).toBe("Tower");
    expect(historyState(project).undo).toBe("Rename to Tower");
  });

  it("can't remove the ground, or undo with nothing done", () => {
    const project = newProject("Test", 5);
    const ground = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!ground) throw new Error("no aim");
    expect(eraseCommand(project, ground)).toBeNull();
    expect(stepCommand(project, "redo")).toBeNull();
  });

  it("turns a block by its placement profile", () => {
    const project = newProject("Test", 5);
    const stairs = project.semantics.add("Stairs", { form: { placement: PLACEMENTS.stairs } });
    const ground = aim(project.world, [0.5, 5, 10], [0, -1, -1], 100);
    if (!ground) throw new Error("no aim");
    // Looking north (-z): the stairs face the player, so their front points south.
    const place = placeCommand(project, ground, stairs, [0, -1, -1]);
    if (!place) throw new Error("no command");
    project.run(place);
    const state = project.world.get(...(ground.place as [number, number, number]));
    expect(state?.semantic).toBe(stairs);
    expect(state?.rotation).not.toBe(0);
  });

  it("derives a palette's semantic the first time it is placed", () => {
    const project = newProject("Test", 5);
    const child = project.semantics.addPalette("Walkway", { extends: ROOT_PALETTE });
    const offer = paletteInfo(project)
      .find((p) => p.id === child)
      ?.semantics.find((s) => s.name === "Wall");
    expect(offer?.ref).toEqual({ palette: child, base: wall(project) });
    const ground = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!ground || !offer) throw new Error("no aim");
    project.run(placeCommand(project, ground, offer.ref, [0, -1, 0]) as never);
    const placed = project.world.get(0, 0, 0)?.semantic as number;
    expect(project.semantics.get(placed)).toMatchObject({ palette: child, base: wall(project) });
  });

  it("fills and clears boxes as one step", () => {
    const project = newProject("Test", 5);
    const id = project.world.states.intern({ semantic: wall(project) });
    project.run(fillBoxCommand(project, [2, 2, 2], [0, 0, 0], id, "Fill"));
    expect(project.world.cellCount).toBe(27);
    project.run(fillBoxCommand(project, [0, 0, 0], [2, 2, 2], EMPTY_ID, "Clear"));
    expect(project.world.cellCount).toBe(0);
    project.run(stepCommand(project, "undo") as never);
    expect(project.world.cellCount).toBe(27);
    project.run(setCellCommand(project, [5, 0, 0], id, "Set"));
    expect(project.world.getId(5, 0, 0)).toBe(id);
  });
});

describe("newProject", () => {
  it("starts empty, with starter semantics on default blocks in the root palette", () => {
    const project = newProject("My build", 6);
    expect(project.settings.name).toBe("My build");
    expect(project.world.cellCount).toBe(0);
    const [root] = paletteInfo(project);
    expect(root?.id).toBe(ROOT_PALETTE);
    expect(root?.semantics.map((s) => s.name)).toEqual(STARTER_SEMANTICS.map((s) => s.name));
    expect(root?.semantics.every((s) => s.block?.startsWith("voxyl:"))).toBe(true);
    expect(
      project.semantics.resolve(project.semantics.byName("Wall") as number).description,
    ).toMatch(/wall/i);
    expect(root?.semantics.find((s) => s.name === "Light")?.glow).toBe(true);
    expect(root?.semantics.find((s) => s.name === "Wall")?.ownLook.tint).toBe("#d9d4c7");
  });
});

describe("palette edits", () => {
  it("adds, renames and re-skins, and ignores a look that is already set", () => {
    const project = newProject("Test", 5);
    const added = addSemanticCommand(project, ROOT_PALETTE, "  Path ");
    if (!added) throw new Error("no command");
    project.run(added);
    expect(project.semantics.byName("Path")).toBeTypeOf("number");
    expect(historyState(project).undo).toBe("Add Path");

    const wallId = wall(project);
    const renamed = renameSemanticCommand(project, wallId, "Stone wall");
    if (!renamed) throw new Error("no command");
    project.run(renamed);
    expect(project.semantics.nameOf(wallId)).toBe("Stone wall");
    expect(renameSemanticCommand(project, wallId, "Stone wall")).toBeNull();

    const look = setLookCommand(project, wallId, { block: "voxyl:oak_stairs", tint: "#d9d4c7" });
    if (!look) throw new Error("no command");
    project.run(look);
    expect(project.semantics.resolve(wallId).look.block).toBe("voxyl:oak_stairs");
    expect(historyState(project).undo).toBe("Stone wall looks like Oak stairs");
    expect(
      setLookCommand(project, wallId, { block: "voxyl:oak_stairs", tint: "#d9d4c7" }),
    ).toBeNull();

    const child = addPaletteCommand(project, "Walkway", ROOT_PALETTE);
    if (!child) throw new Error("no command");
    project.run(child);
    const palette = project.semantics.paletteByName("Walkway");
    expect(palette?.extends).toBe(ROOT_PALETTE);
    expect(historyState(project).undo).toBe("Add palette Walkway");
    expect(addSemanticCommand(project, 99, "Nope")).toBeNull();

    const made = addSemanticCommand(project, ROOT_PALETTE, "Hedge", {
      description: "The edge of a garden",
      look: { block: "voxyl:oak_leaves" },
    });
    if (!made) throw new Error("no command");
    project.run(made);
    const hedge = project.semantics.byName("Hedge");
    if (hedge === undefined) throw new Error("no hedge");
    expect(project.semantics.resolve(hedge).look.block).toBe("voxyl:oak_leaves");
    const edited = editSemanticCommand(project, hedge, {
      name: "Hedge",
      description: "A garden edge",
      look: { block: "voxyl:oak_leaves", glow: true },
    });
    if (!edited) throw new Error("no command");
    project.run(edited);
    expect(historyState(project).undo).toBe("Edit Hedge");
    expect(project.semantics.resolve(hedge).look.glow).toBe(true);
    expect(
      editSemanticCommand(project, hedge, {
        name: "Hedge",
        description: "A garden edge",
        look: { block: "voxyl:oak_leaves", glow: true },
      }),
    ).toBeNull();
  });
});

describe("placement from the look's block", () => {
  const profiles = (project: ReturnType<typeof newProject>) => {
    const blocks = defaultLibrary().blocks;
    project.setBlockProfiles((ref) => {
      const name = ref?.slice(ref.indexOf(":") + 1);
      const block = name ? blocks[name] : undefined;
      return block ? profileOfBlock(block) : undefined;
    });
  };

  it("faces stairs at the player and lays a log along the clicked face", () => {
    const project = newProject("Test", 5);
    profiles(project);
    const stairs = wall(project);
    project.run(setLookCommand(project, stairs, { block: "voxyl:oak_stairs" }) as never);
    const ground = aim(project.world, [0.5, 5, 10], [0, -1, -1], 100);
    if (!ground?.place) throw new Error("no aim");
    project.run(placeCommand(project, ground, stairs, [0, -1, -1]) as never);
    const stood = project.world.get(...ground.place);
    expect(stood && sideOf(facingOf(stood.rotation))).toBe("south");

    const log = project.semantics.byName("Floor") as number;
    project.run(setLookCommand(project, log, { block: "voxyl:oak_log" }) as never);
    project.world.setId(0, 0, 0, project.world.states.intern({ semantic: stairs }));
    const side = aim(project.world, [5, 0.5, 0.5], [-1, 0, 0], 100);
    if (!side?.place) throw new Error("no aim");
    project.run(placeCommand(project, side, log, [-1, 0, 0]) as never);
    const laid = project.world.get(...side.place);
    // Axis symmetry: the log lies along the clicked face, either end first.
    const axis = laid ? upOf(laid.rotation) : [0, 0, 0];
    expect(axis.map(Math.abs)).toEqual([1, 0, 0]);
  });

  it("stores a cube as one rotation, and a form's profile beats the block's", () => {
    const project = newProject("Test", 5);
    profiles(project);
    const stone = wall(project);
    project.run(setLookCommand(project, stone, { block: "voxyl:stone" }) as never);
    const ground = aim(project.world, [0.5, 5, 10], [0, -1, -1], 100);
    if (!ground?.place) throw new Error("no aim");
    project.run(placeCommand(project, ground, stone, [0, -1, -1]) as never);
    expect(project.world.get(...ground.place)?.rotation).toBe(0);

    project.semantics.update(stone, { form: { placement: PLACEMENTS.log } });
    expect(project.placement(stone).profile).toMatchObject({ pick: "attach" });
  });
});

describe("shared palettes", () => {
  it("shares a palette with its looks and descriptions, and links it into another project", () => {
    const from = newProject("From", 5);
    const spec = sharedFromPalette(from, ROOT_PALETTE, "k1");
    expect(spec.semantics.map((s) => s.name)).toEqual(STARTER_SEMANTICS.map((s) => s.name));
    expect(spec.semantics.find((s) => s.name === "Wall")?.look?.block).toBe("voxyl:white_concrete");
    const into = newProject("Into", 5);
    into.run(linkPaletteCommand(into, { ...spec, version: 1 }));
    const linked = paletteInfo(into).find((p) => p.linkedKey === "k1");
    expect(linked?.linked).toBe(true);
    expect(linked?.linkedVersion).toBe(1);
    expect(linked?.semantics.find((s) => s.name === "Wall")?.description).toMatch(/wall/i);
    expect(historyState(into).undo).toBe("Use Main (v1)");
    // The project already has a Main, so the copy is called Main (shared).
    expect(linked?.name).toBe("Main (shared)");
  });

  it("describes a semantic, and clears the description with an empty one", () => {
    const project = newProject("Test", 5);
    const command = describeSemanticCommand(project, wall(project), "  The outer skin  ");
    if (!command) throw new Error("no command");
    project.run(command);
    expect(project.semantics.resolve(wall(project)).description).toBe("The outer skin");
    expect(describeSemanticCommand(project, wall(project), "The outer skin")).toBeNull();
    const clear = describeSemanticCommand(project, wall(project), "");
    if (!clear) throw new Error("no command");
    project.run(clear);
    expect(project.semantics.resolve(wall(project)).description ?? "").toBe("");
  });
});

describe("shaped semantics place parts", () => {
  /** A project whose Trim is a Strip, and a Deck of whole blocks under it. */
  function shaped() {
    const project = newProject("Test", 5);
    const trim = project.semantics.byName("Trim") as number;
    project.run({
      id: "form",
      kind: "semantic_update",
      args: { semantic: trim, form: { shape: "face1" } },
    });
    const deck = wall(project);
    project.world.setId(0, 0, 0, project.world.states.intern({ semantic: deck }));
    return { project, trim };
  }

  it("lays a cover against the face that was clicked, in the cell beside it", () => {
    const { project, trim } = shaped();
    const top = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!top) throw new Error("no aim");
    const place = placeCommand(project, top, trim, [0, -1, 0]);
    if (!place) throw new Error("no command");
    expect(place.label).toBe("Place Trim");
    project.run(place);
    const state = project.world.get(0, 1, 0);
    expect(state?.semantic).toBe(0);
    expect(state?.parts).toEqual([{ semantic: trim, shape: "face1", slot: 0 }]);
    expect(historyState(project).undo).toBe("Place Trim");
  });

  it("shows the same part as a ghost, and the opposite modifier moves it", () => {
    const { project, trim } = shaped();
    const top = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!top) throw new Error("no aim");
    expect(partGhost(project, top, trim, false)).toEqual({
      cell: [0, 1, 0],
      shape: "face1",
      slot: 0,
    });
    expect(partGhost(project, top, trim, true)).toEqual({
      cell: [0, 1, 0],
      shape: "face1",
      slot: 1,
    });
    // A semantic with no shape has no ghost.
    expect(partGhost(project, top, wall(project), false)).toBeNull();
  });

  it("adds to the parts already in the cell, and refuses a taken slot", () => {
    const { project, trim } = shaped();
    const top = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!top) throw new Error("no aim");
    project.run(placeCommand(project, top, trim, [0, -1, 0]) as never);
    // Aiming down again now meets the cover (at the bottom of the cell above), so a second
    // cover of the same slot is refused rather than duplicated.
    const again = aim(project.world, [0.5, 5, 0.5], [0, -1, 0], 100);
    if (!again) throw new Error("no aim");
    expect(again.part).toBeDefined();
    const second = placeCommand(project, again, trim, [0, -1, 0]);
    if (second) project.run(second);
    expect(project.world.get(0, 1, 0)?.parts.length).toBeLessThanOrEqual(2);
    expect(new Set(project.world.get(0, 1, 0)?.parts.map((p) => p.slot)).size).toBe(
      project.world.get(0, 1, 0)?.parts.length,
    );
  });

  it("removes only the part that was aimed at", () => {
    const { project, trim } = shaped();
    const accent = project.semantics.byName("Accent") as number;
    project.run({
      id: "cell",
      kind: "set",
      args: {
        states: [
          {
            parts: [
              { semantic: trim, shape: "face1", slot: 0 },
              { semantic: accent, shape: "face1", slot: 1 },
            ],
          },
        ],
        cells: [4, 0, 4, 0],
      },
    });
    // From above, the ray meets the cover against the top (slot 1, the Accent one).
    const target = aim(project.world, [4.5, 6, 4.5], [0, -1, 0], 100);
    if (!target) throw new Error("no aim");
    const command = eraseCommand(project, target);
    expect(command?.label).toBe("Remove Accent");
    project.run(command as never);
    expect(project.world.get(4, 0, 4)?.parts).toEqual([
      { semantic: trim, shape: "face1", slot: 0 },
    ]);
    // Removing the last part empties the cell.
    const next = aim(project.world, [4.5, 6, 4.5], [0, -1, 0], 100);
    if (!next) throw new Error("no aim");
    project.run(eraseCommand(project, next) as never);
    expect(project.world.getId(4, 0, 4)).toBe(EMPTY_ID);
  });

  it("puts a shaped part on the ground plane", () => {
    const { project, trim } = shaped();
    const ground = aim(project.world, [6.5, 5, 6.5], [0, -1, 0], 100);
    if (!ground) throw new Error("no aim");
    expect(ground.hit).toBeNull();
    const place = placeCommand(project, ground, trim, [0, -1, 0]);
    if (!place) throw new Error("no command");
    project.run(place);
    expect(project.world.get(6, 0, 6)?.parts).toEqual([
      { semantic: trim, shape: "face1", slot: 0 },
    ]);
  });
});

describe("project settings", () => {
  it("changes north and the grid offset as one undoable step each, and ignores no-ops", () => {
    const project = newProject("Test", 5);
    expect(settingsCommand(project, { north: "north", grid: [0, 0] })).toBeNull();
    const turn = settingsCommand(project, { north: "east" });
    if (!turn) throw new Error("no command");
    project.run(turn);
    expect(project.settings.north).toBe("east");
    expect(historyState(project).undo).toBe("North is now east");
    const grid = settingsCommand(project, { grid: [4, 9] });
    if (!grid) throw new Error("no command");
    project.run(grid);
    expect(project.settings.grid).toEqual([4, 9]);
    expect(project.settings.north).toBe("east");
    project.run(stepCommand(project, "undo") as never);
    expect(project.settings.grid).toEqual([0, 0]);
    expect(project.settings.north).toBe("east");
    project.run(stepCommand(project, "undo") as never);
    expect(project.settings.north).toBe("north");
  });

  it("touches no cell when north changes", () => {
    const project = newProject("Test", 5);
    const id = project.world.states.intern({ semantic: wall(project) });
    project.world.setId(1, 2, 3, id);
    project.run(settingsCommand(project, { north: "west" }) as never);
    expect(project.world.getId(1, 2, 3)).toBe(id);
    expect(project.world.cellCount).toBe(1);
  });
});
