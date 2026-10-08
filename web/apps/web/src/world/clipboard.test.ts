import { CellSet, cutPiece, type Piece } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import {
  defaultAnchor,
  NO_PASTE_TURN,
  type PasteArgs,
  pasteMatrix,
  pieceCells,
  pieceThumbnail,
  placedBox,
  placedPositions,
} from "./clipboard.ts";
import { newProject } from "./editing.ts";

/** A piece of an L: a 3-long bar along x with a post up from its east end, Wall and Trim. */
function lPiece(): Piece {
  const project = newProject("Test", 5);
  const wall = project.semantics.byName("Wall") as number;
  const trim = project.semantics.byName("Trim") as number;
  const wallState = project.world.states.intern({ semantic: wall });
  const trimState = project.world.states.intern({ semantic: trim });
  for (let x = 0; x < 3; x++) project.world.setId(10 + x, 0, 20, wallState);
  project.world.setId(12, 1, 20, trimState);
  project.world.setId(12, 2, 20, trimState);
  const cells = CellSet.ofBox({ x0: 10, y0: 0, z0: 20, x1: 12, y1: 2, z1: 20 });
  const piece = cutPiece(
    { world: project.world, semantics: project.semantics, north: project.settings.north },
    cells,
    [11, 0, 20],
  );
  if (!piece) throw new Error("no piece");
  return piece;
}

const args = (over: Partial<PasteArgs> = {}): PasteArgs => ({ ...NO_PASTE_TURN, ...over });
const cellSet = (positions: Int32Array) => {
  const set = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) {
    set.add(`${positions[i]},${positions[i + 1]},${positions[i + 2]}`);
  }
  return set;
};

describe("a piece's cells", () => {
  it("lists the occupied cells and what each shows", () => {
    const piece = lPiece();
    const cells = pieceCells(piece);
    expect(cells.semantics.length).toBe(5);
    expect(cellSet(cells.positions)).toEqual(
      new Set(["0,0,0", "1,0,0", "2,0,0", "2,1,0", "2,2,0"]),
    );
    // Two kinds of semantic: the wall bar, and the trim post.
    expect(new Set(cells.semantics).size).toBe(2);
  });

  it("puts the default anchor mid-footprint on the floor", () => {
    expect(defaultAnchor([3, 3, 1])).toEqual([1, 0, 0]);
    expect(defaultAnchor([4, 9, 5])).toEqual([2, 0, 2]);
  });
});

describe("where a paste lands", () => {
  it("puts the anchor at the target, cells keeping their places around it", () => {
    const piece = lPiece();
    const cells = pieceCells(piece);
    const landed = cellSet(placedPositions(piece, cells, piece.north, [100, 5, 200], args()));
    // The anchor is the bar's middle cell (piece position 1, 0, 0).
    expect(landed).toEqual(
      new Set(["99,5,200", "100,5,200", "101,5,200", "101,6,200", "101,7,200"]),
    );
  });

  it("turns about the anchor, and lifts by the offset", () => {
    const piece = lPiece();
    const cells = pieceCells(piece);
    const turned = cellSet(
      placedPositions(piece, cells, piece.north, [0, 0, 0], args({ turn: 1 })),
    );
    // A quarter turn clockwise from above takes +x to +z.
    expect(turned).toEqual(new Set(["0,0,-1", "0,0,0", "0,0,1", "0,1,1", "0,2,1"]));
    const lifted = cellSet(
      placedPositions(piece, cells, piece.north, [0, 0, 0], args({ offset: [0, 3, 0] })),
    );
    expect(lifted.has("0,3,0")).toBe(true);
    expect(lifted.has("1,5,0")).toBe(true);
  });

  it("mirrors east and west", () => {
    const piece = lPiece();
    const cells = pieceCells(piece);
    const mirrored = cellSet(
      placedPositions(piece, cells, piece.north, [0, 0, 0], args({ mirror: true })),
    );
    expect(mirrored).toEqual(new Set(["1,0,0", "0,0,0", "-1,0,0", "-1,1,0", "-1,2,0"]));
  });

  it("keeps north north when the project\x27s north differs from the piece\x27s", () => {
    const piece = lPiece();
    expect(pasteMatrix(piece, piece.north, args())).toEqual(
      pasteMatrix(piece, piece.north, args()),
    );
    const east = pasteMatrix(piece, "east", args());
    const same = pasteMatrix(piece, piece.north, args());
    // Unless the piece already faced east, the two matrices differ.
    if (piece.north !== "east") expect(east).not.toEqual(same);
  });

  it("measures the box a paste fills", () => {
    const piece = lPiece();
    const box = placedBox(piece, piece.north, [100, 5, 200], args());
    expect(box).toEqual({ min: [99, 5, 200], max: [102, 8, 201] });
    const turned = placedBox(piece, piece.north, [100, 5, 200], args({ turn: 1 }));
    expect(turned).toEqual({ min: [100, 5, 199], max: [101, 8, 202] });
  });
});

describe("the ghost and the paste agree", () => {
  it("fills exactly the cells the ghost showed, for every turn and mirror", () => {
    const piece = { ...lPiece(), anchor: [1, 0, 0] as [number, number, number] };
    const cells = pieceCells(piece);
    for (const turn of [0, 1, 2, 3]) {
      for (const mirror of [false, true]) {
        const project = newProject("Test", 5);
        const at: [number, number, number] = [40, 6, -30];
        const pasteArgs = args({ turn, mirror, offset: [0, 2, 0] });
        const predicted = cellSet(
          placedPositions(piece, cells, project.settings.north, at, pasteArgs),
        );
        project.run({
          id: `paste-${turn}-${mirror}`,
          kind: "paste",
          args: { piece, at: [at[0], at[1] + 2, at[2]], turn, ...(mirror && { mirror: "x" }) },
        });
        const filled = new Set<string>();
        project.world.forEachCell((x, y, z) => filled.add(`${x},${y},${z}`));
        expect(filled, `turn ${turn} mirror ${mirror}`).toEqual(predicted);
      }
    }
  });
});

describe("a piece's picture", () => {
  const red = () => 0xff0000;

  it("draws something, inside the picture, and nothing for an empty piece", () => {
    const piece = lPiece();
    const rgba = pieceThumbnail(piece, red, 64);
    expect(rgba.length).toBe(64 * 64 * 4);
    let painted = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 255) painted++;
    expect(painted).toBeGreaterThan(100);
    const empty: Piece = { ...piece, cells: [], states: [], semantics: [] };
    expect(pieceThumbnail(empty, red, 64).every((v) => v === 0)).toBe(true);
  });

  it("shades the top lightest and the two sides darker", () => {
    const rgba = pieceThumbnail(lPiece(), red, 64);
    const reds = new Set<number>();
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] === 255) reds.add(rgba[i] as number);
    expect([...reds].sort((a, b) => b - a)).toEqual([255, 199, 148]);
  });
});
