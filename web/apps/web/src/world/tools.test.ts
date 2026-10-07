import { describe, expect, it } from "vitest";
import { type Aim, historyState, newProject } from "./editing.ts";
import type { Vec3 } from "./protocol.ts";
import { columnCells, exchangeCells, toolCommand, WAND_LIMIT, wandCells } from "./tools.ts";

type P = ReturnType<typeof newProject>;
const id = (project: P, name: string) => project.semantics.byName(name) as number;
const put = (project: P, name: string, cells: Vec3[]) => {
  const state = project.world.states.intern({ semantic: id(project, name) });
  for (const c of cells) project.world.setId(c[0], c[1], c[2], state);
};
const onFace = (hit: Vec3, face: Vec3): Aim => ({
  hit,
  id: 1,
  place: [hit[0] + face[0], hit[1] + face[1], hit[2] + face[2]],
  face,
  hitY: 0.5,
});
const sorted = (cells: Vec3[]) => cells.map((c) => c.join()).sort();

describe("the wand", () => {
  it("grows the clicked semantic's run on that face, and only that semantic", () => {
    const project = newProject("Test", 5);
    // A floor row of Wall with a Trim cell at the end, and a Wall above one cell.
    put(project, "Wall", [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    put(project, "Trim", [[3, 0, 0]]);
    put(project, "Wall", [[1, 1, 0]]);
    const cells = wandCells(project.world, onFace([0, 0, 0], [0, 1, 0]));
    // Up from each Wall whose top is open; (1,1,0) is full; the Trim is another semantic.
    expect(sorted(cells)).toEqual(
      sorted([
        [0, 1, 0],
        [2, 1, 0],
      ]),
    );
  });

  it("stays in the clicked face's plane and needs a block", () => {
    const project = newProject("Test", 5);
    put(project, "Wall", [
      [0, 0, 0],
      [0, 1, 0],
    ]);
    // Clicking the top of (0,1,0): (0,0,0) is below that plane, so only one cell.
    expect(wandCells(project.world, onFace([0, 1, 0], [0, 1, 0]))).toEqual([[0, 2, 0]]);
    const ground: Aim = { hit: null, id: 0, place: [5, 0, 5], face: [0, 1, 0], hitY: 1 };
    expect(wandCells(project.world, ground)).toEqual([]);
  });

  it("reaches WAND_LIMIT cells each way", () => {
    const project = newProject("Test", 5);
    const row: Vec3[] = [];
    for (let x = 0; x <= WAND_LIMIT + 10; x++) row.push([x, 0, 0]);
    put(project, "Wall", row);
    expect(wandCells(project.world, onFace([0, 0, 0], [0, 1, 0]))).toHaveLength(WAND_LIMIT + 1);
  });
});

describe("build to me", () => {
  it("lays a column toward the camera along the face's axis, one short of it", () => {
    const project = newProject("Test", 5);
    put(project, "Wall", [[0, 0, 0]]);
    const cells = columnCells(project.world, onFace([0, 0, 0], [0, 1, 0]), [5.5, 4.2, 9], 1);
    expect(cells).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [0, 3, 0],
    ]);
  });

  it("widens with the brush and skips full cells", () => {
    const project = newProject("Test", 5);
    put(project, "Wall", [
      [0, 0, 0],
      [1, 1, 1],
    ]);
    const cells = columnCells(project.world, onFace([0, 0, 0], [0, 1, 0]), [0, 2.5, 0], 3);
    expect(cells).toHaveLength(8); // one 3×3 layer at y = 1, less the full cell
  });

  it("builds nothing toward a camera behind the face", () => {
    const project = newProject("Test", 5);
    put(project, "Wall", [[0, 5, 0]]);
    expect(columnCells(project.world, onFace([0, 5, 0], [0, 1, 0]), [0, 2, 0], 1)).toEqual([]);
  });
});

describe("exchange", () => {
  it("swaps the clicked block alone with brush 1, and its connected run within reach", () => {
    const project = newProject("Test", 5);
    const wall: Vec3[] = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) wall.push([x, y, 0]);
    put(project, "Wall", wall);
    put(project, "Trim", [[3, 2, 0]]);
    const click = onFace([2, 2, 0], [0, 0, 1]);
    expect(exchangeCells(project.world, click, 1)).toEqual([[2, 2, 0]]);
    // A reach of one around it: 3×3 less the Trim.
    expect(exchangeCells(project.world, click, 3)).toHaveLength(8);
  });

  it("is one labelled undo step that replaces in place", () => {
    const project = newProject("Test", 5);
    put(project, "Wall", [
      [0, 0, 0],
      [1, 0, 0],
    ]);
    const command = toolCommand(
      project,
      { tool: "exchange", aim: onFace([0, 0, 0], [0, 1, 0]), camera: [0, 9, 0], brush: 3 },
      id(project, "Roof"),
      [0, -1, 0],
    );
    if (!command) throw new Error("no command");
    project.run(command);
    expect(project.world.get(1, 0, 0)?.semantic).toBe(id(project, "Roof"));
    expect(historyState(project).undo).toBe("Exchange: 2 Roof");
  });
});
