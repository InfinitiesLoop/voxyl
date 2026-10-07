import { EMPTY_ID } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { outlineOf } from "../editor/outline.ts";
import {
  clearSelectionCommand,
  fillSelectionCommand,
  historyState,
  newProject,
  replaceSelectionCommand,
  resemanticSelectionCommand,
  selectCommand,
} from "./editing.ts";
import { selectionView } from "./selection.ts";

const wall = (project: ReturnType<typeof newProject>) => project.semantics.byName("Wall") as number;
const floor = (project: ReturnType<typeof newProject>) =>
  project.semantics.byName("Floor") as number;

function put(project: ReturnType<typeof newProject>, x: number, z: number, semantic: number): void {
  const id = project.world.states.intern({ semantic });
  project.world.setId(x, 0, z, id);
}

describe("selection commands", () => {
  it("selects a box, grows it through faces, and does not become the undo step", () => {
    const project = newProject("Test", 5);
    project.run(selectCommand({ box: [0, 0, 0, 0, 0, 0] }));
    expect(project.selection?.size).toBe(1);
    project.run(selectCommand({ grow: 1, of: { selection: true } }));
    expect(project.selection?.size).toBe(7);
    // Selecting is not an undo step, so the starter semantics are still what undo would revert.
    expect(historyState(project).undo).toBe("semantic_add");
  });

  it("fills the box, replaces only what is occupied, and switches one semantic", () => {
    const project = newProject("Test", 5);
    put(project, 0, 0, wall(project));
    project.run(selectCommand({ box: [0, 0, 0, 1, 0, 0] }));

    const replace = replaceSelectionCommand(project, floor(project), [0, -1, 0]);
    if (!replace) throw new Error("no replace");
    project.run(replace);
    expect(project.world.get(0, 0, 0)?.semantic).toBe(floor(project));
    expect(project.world.getId(1, 0, 0)).toBe(EMPTY_ID);

    const fill = fillSelectionCommand(project, wall(project), [0, 0, -1]);
    if (!fill) throw new Error("no fill");
    project.run(fill);
    expect(project.world.get(1, 0, 0)?.semantic).toBe(wall(project));
    expect(historyState(project).undo).toBe("Fill with Wall");

    const switched = resemanticSelectionCommand(project, wall(project), floor(project));
    if (!switched) throw new Error("no resemantic");
    project.run(switched);
    expect(project.world.get(0, 0, 0)?.semantic).toBe(floor(project));
    expect(project.world.get(1, 0, 0)?.semantic).toBe(floor(project));

    project.run(clearSelectionCommand(project) as never);
    expect(project.world.getId(0, 0, 0)).toBe(EMPTY_ID);
    expect(project.world.getId(1, 0, 0)).toBe(EMPTY_ID);
  });

  it("the wand takes connected cells of one semantic and stops at a gap", () => {
    const project = newProject("Test", 5);
    put(project, 0, 0, wall(project));
    put(project, 1, 0, wall(project));
    put(project, 1, 1, wall(project));
    put(project, 3, 0, wall(project));
    put(project, 0, 1, floor(project));
    project.run(selectCommand({ structure: { seed: [0, 0, 0], semantics: [wall(project)] } }));
    expect(project.selection?.size).toBe(3);
    expect(project.selection?.has(0, 0, 0)).toBe(true);
    expect(project.selection?.has(1, 0, 0)).toBe(true);
    expect(project.selection?.has(1, 0, 1)).toBe(true);
    expect(project.selection?.has(3, 0, 0)).toBe(false);
    expect(project.selection?.has(0, 0, 1)).toBe(false);

    const selected = project.selection;
    if (!selected) throw new Error("no selection");
    const view = selectionView(project, outlineOf(selected));
    expect(view.occupied).toBe(3);
    expect(view.cells).toBe(3);
    expect(view.box).toBe(false);
    expect(view.semantics[0]).toMatchObject({ name: "Wall", count: 3 });
    expect(view.lines.length).toBeGreaterThan(0);
  });
});
