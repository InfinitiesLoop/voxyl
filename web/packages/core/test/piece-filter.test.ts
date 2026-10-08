import { describe, expect, it } from "vitest";
import { filterPiece, forEachPieceCell, type Piece } from "../src/index.ts";

/** A 4x2x3 piece: floor (semantic 1) under a pillar of 2 (semantic 2) at x3 z2, one air cell. */
function sample(): Piece {
  const w = 4;
  const h = 2;
  const d = 3;
  const grid = new Array<number>(w * h * d).fill(0);
  const at = (x: number, y: number, z: number) => (y * d + z) * w + x;
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) grid[at(x, 0, z)] = 1;
  grid[at(3, 1, 2)] = 2;
  grid[at(0, 1, 0)] = 3; // air
  const cells: number[] = [];
  for (const n of grid) {
    if (cells.length > 0 && cells[cells.length - 2] === n)
      cells[cells.length - 1] = (cells[cells.length - 1] ?? 0) + 1;
    else cells.push(n, 1);
  }
  return {
    size: [w, h, d],
    north: "north",
    anchor: [3, 1, 2],
    semantics: [
      { name: "Floor", palette: "Main" },
      { name: "Pillar", palette: "Main" },
      { name: "Glass", palette: "Main" },
    ],
    states: [[1, 0], [2, 0], null],
    cells,
  };
}

function listed(piece: Piece): string[] {
  const out: string[] = [];
  forEachPieceCell(piece, (x, y, z, n) => {
    const state = piece.states[n - 1];
    out.push(
      `${x},${y},${z}:${state ? (piece.semantics[(state[0] ?? 1) - 1]?.name ?? "?") : "air"}`,
    );
  });
  return out;
}

describe("filterPiece", () => {
  it("is the piece itself when nothing is asked", () => {
    const piece = sample();
    expect(filterPiece(piece, {})).toBe(piece);
  });

  it("drops an excluded semantic's cells and renumbers the rest", () => {
    const piece = filterPiece(sample(), { exclude: new Set([1]) });
    expect(piece?.semantics.map((s) => s.name)).toEqual(["Pillar"]);
    expect(piece?.size).toEqual([4, 2, 3]);
    expect(listed(piece as Piece)).toEqual(["0,1,0:air", "3,1,2:Pillar"]);
  });

  it("trims the box to what is kept, moving the anchor with it", () => {
    const piece = filterPiece(sample(), { exclude: new Set([1]), trim: true }) as Piece;
    expect(piece.size).toEqual([1, 1, 1]);
    expect(listed(piece)).toEqual(["0,0,0:Pillar"]);
    expect(piece.anchor).toEqual([0, 0, 0]);
  });

  it("trims without excluding: air around the cells goes", () => {
    const piece = filterPiece(sample(), { trim: true }) as Piece;
    expect(piece.size).toEqual([4, 2, 3]); // the floor fills the footprint and the pillar the height
  });

  it("keeps the parts that remain in a cell of parts", () => {
    const piece: Piece = {
      size: [2, 1, 1],
      north: "north",
      semantics: [
        { name: "A", palette: "Main" },
        { name: "B", palette: "Main" },
      ],
      states: [
        [
          0,
          0,
          {},
          [
            [1, "slab", 0],
            [2, "slab", 1],
          ],
        ],
        [1, 0],
      ],
      cells: [1, 1, 2, 1],
    };
    const left = filterPiece(piece, { exclude: new Set([1]) }) as Piece;
    expect(left.semantics.map((s) => s.name)).toEqual(["B"]);
    expect(left.states[0]).toEqual([0, 0, {}, [[1, "slab", 1]]]);
    expect(left.cells).toEqual([1, 1]); // the whole block of A is gone, trailing outside implied
  });

  it("is null when nothing is left", () => {
    expect(filterPiece(sample(), { exclude: new Set([1, 2]) })).toBeNull();
  });
});
