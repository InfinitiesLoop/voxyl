import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CellStateArg,
  type Command,
  compose,
  cutPiece,
  type Direction,
  facingOf,
  inverse,
  loadPrefab,
  mirror,
  type Piece,
  Project,
  packBundle,
  placementMatrix,
  prefabHash,
  ROOT_PALETTE,
  rotationFacing,
  savePrefab,
  transformRotation,
  turnClockwise,
  turnsBetween,
  unpackBundle,
} from "../src/index.ts";

let n = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `p${n++}`, kind, args });

/** Every cell, positions relative to the build's corner, semantics by name. */
function describeCells(p: Project, relative = true): string[] {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  p.world.forEachCell((x, y, z) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    z0 = Math.min(z0, z);
  });
  if (!relative) [x0, y0, z0] = [0, 0, 0];
  const out: string[] = [];
  p.world.forEachCell((x, y, z, id) => {
    const s = p.world.states.get(id);
    if (!s) return;
    const name = (sem: number) => p.semantics.nameOf(sem);
    const parts = s.parts.map((q) => `${name(q.semantic)}/${q.shape}/${q.slot}`).join("+");
    out.push(`${x - x0},${y - y0},${z - z0}:${name(s.semantic)}:${s.rotation}:${parts}`);
  });
  return out.sort();
}

/** A project with two semantics and a few cells: a stair facing north, parts, a roof tile. */
function build(north: Direction = "north") {
  const p = new Project({ chunkBits: 4 });
  p.run(cmd("settings", { north }));
  const wall = p.semantics.add("Wall", { look: { block: "mc:stone" } });
  const trim = p.semantics.add("Trim", { form: { shape: "edge1" }, look: { tint: "#00ffff" } });
  const west = rotationFacing([-1, 0, 0], [0, 1, 0]);
  p.run(
    cmd("set", {
      states: [
        { semantic: wall },
        { semantic: wall, rotation: west },
        {
          parts: [
            { semantic: trim, shape: "edge1", slot: 0 },
            { semantic: wall, shape: "face1", slot: 3 },
          ],
        },
        { parts: [{ semantic: trim, shape: "roof_tile", slot: 1 }] },
      ],
      cells: [0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 0, 1, 0, 2, 0, 0, 3, 3, 3, 2, 1, 0],
    }),
  );
  return { p, wall, trim };
}

describe("placements", () => {
  it("turns clockwise from above and counts turns between norths", () => {
    const m = placementMatrix(1);
    expect([m[2], m[8]]).toEqual([-1, 0]); // -Z (north) goes to +X (east)
    expect(turnsBetween("north", "east")).toBe(1);
    expect(turnsBetween("east", "north")).toBe(3);
    expect(turnsBetween("west", "west")).toBe(0);
  });

  it("composes block rotations with turns and mirrors", () => {
    for (let r = 0; r < 24; r++) {
      let t = r;
      for (let i = 0; i < 4; i++) t = transformRotation(t, placementMatrix(1));
      expect(t).toBe(r);
      expect(transformRotation(r, placementMatrix(1))).toBe(compose(turnClockwise(1), r));
      const mx = placementMatrix(0, "x");
      expect(transformRotation(r, mx)).toBe(mirror(r, 0));
      expect(transformRotation(transformRotation(r, mx), mx)).toBe(r);
    }
    expect(inverse(turnClockwise(1))).toBe(turnClockwise(3));
  });
});

describe("copy, move and transform", () => {
  it("copies with a turn: the corner lands at `to`, blocks and parts turn", () => {
    const { p } = build();
    const r = p.run(cmd("copy", { where: { box: [0, 0, 0, 3, 3, 3] }, to: [10, 0, 10], turn: 1 }));
    expect(r.report.notes.cells).toBe(6);
    const box = r.report.bounds;
    expect(box && [box.x0, box.y0, box.z0]).toEqual([10, 0, 10]);
    p.world.forEachCell((x, _y, z, id) => {
      const s = p.world.states.get(id);
      if (x >= 10 && z >= 10 && s?.parts.some((q) => q.shape === "face1")) {
        // The cover on the south side (slot 3) is now on the west side (slot 4).
        expect(s.parts.find((q) => q.shape === "face1")?.slot).toBe(4);
      }
    });
    // The stair at (2, 0, 0) faced west; turned clockwise it faces north, at (13, 0, 12).
    expect(facingOf(p.world.get(13, 0, 12)?.rotation ?? 0)).toEqual([0, 0, -1]);
  });

  it("moves: the source empties, undo puts it back", () => {
    const { p } = build();
    const before = describeCells(p, false);
    p.run(cmd("move", { where: { box: [0, 0, 0, 3, 3, 3] }, to: [2, 0, 0] }));
    expect(describeCells(p, false)).not.toEqual(before);
    expect(p.world.getId(0, 0, 0)).toBe(0);
    expect(describeCells(p)).toEqual(describeCells(build().p));
    p.run(cmd("undo", { target: p.undoTarget() }));
    expect(describeCells(p, false)).toEqual(before);
  });

  it("four quarter turns in place, or two mirrors, are the identity (random builds)", () => {
    const cell = fc.record({
      x: fc.integer({ min: 0, max: 5 }),
      y: fc.integer({ min: 0, max: 3 }),
      z: fc.integer({ min: 0, max: 4 }),
      state: fc.oneof(
        fc.integer({ min: 0, max: 23 }).map((rotation) => ({ semantic: 1, rotation })),
        fc
          .record({
            shape: fc.constantFrom("face1", "edge2", "corner4", "hollow2"),
            slot: fc.nat(11),
          })
          .map(({ shape, slot }) => ({
            parts: [
              {
                semantic: 1,
                shape,
                slot:
                  shape.startsWith("face") || shape.startsWith("hollow")
                    ? slot % 6
                    : shape.startsWith("corner")
                      ? slot % 8
                      : slot,
              },
            ],
          })),
        fc
          .record({
            shape: fc.constantFrom("roof_tile", "roof_ridge", "roof_outer_corner"),
            slot: fc.nat(23),
          })
          .map(({ shape, slot }) => ({ parts: [{ semantic: 1, shape, slot }] })),
      ),
    });
    fc.assert(
      fc.property(fc.array(cell, { minLength: 1, maxLength: 30 }), (cells) => {
        const p = new Project({ chunkBits: 4 });
        p.semantics.add("Wall");
        const states: CellStateArg[] = cells.map((c) => c.state);
        p.run(cmd("set", { states, cells: cells.flatMap((c, i) => [c.x, c.y, c.z, i]) }));
        const original = describeCells(p, false);
        const where = {
          box: [0, 0, 0, 5, 3, 5] as [number, number, number, number, number, number],
        };
        for (let i = 0; i < 4; i++)
          p.run(cmd("transform", { where: { box: [0, 0, 0, 5, 3, 5] }, turn: 1 }));
        expect(describeCells(p, false)).toEqual(original);
        p.run(cmd("transform", { where, mirror: "x" }));
        p.run(cmd("transform", { where, mirror: "x" }));
        expect(describeCells(p, false)).toEqual(original);
      }),
      { numRuns: 40 },
    );
  });

  it("leaves parts with no image out and says so", () => {
    const p = new Project({ chunkBits: 4 });
    const s = p.semantics.add("Odd");
    // Commands refuse unknown shapes, but a file can still hold one.
    p.world.set(0, 0, 0, { parts: [{ semantic: s, shape: "mystery", slot: 0 }] });
    const r = p.run(cmd("move", { where: { box: [0, 0, 0, 0, 0, 0] }, to: [5, 0, 0], turn: 1 }));
    expect(r.report.notes.rejected).toBe(1);
    expect(p.world.getId(0, 0, 0)).not.toBe(0); // a move leaves it where it was
  });
});

describe("pieces and paste", () => {
  it("cuts and pastes within a project, mapping semantics by id even after a rename", () => {
    const { p, wall } = build();
    const piece = cutPiece(
      { world: p.world, semantics: p.semantics, id: p.id, north: p.settings.north },
      p.cells({ box: [0, 0, 0, 3, 3, 3] }),
    ) as Piece;
    p.run(cmd("semantic_update", { semantic: wall, name: "Bulkhead" }));
    const before = p.semantics.size;
    p.run(cmd("paste", { piece, at: [20, 0, 0] }));
    expect(p.semantics.size).toBe(before);
    const pasted = describeCells(p).filter((c) => c.startsWith("2"));
    expect(pasted.length).toBeGreaterThan(0);
    expect(p.world.cellCount).toBe(12);
  });

  it("pastes into another project: creates palettes and semantics with their looks", () => {
    const { p } = build();
    const walkway = p.run(cmd("palette_add", { name: "Walkway", extends: ROOT_PALETTE })).report
      .created.palettes[0] as number;
    p.run(
      cmd("fill", {
        where: { box: [0, 5, 0, 1, 5, 0] },
        state: { semantic: { palette: walkway, base: 1 } },
      }),
    );
    const piece = cutPiece(
      { world: p.world, semantics: p.semantics, id: p.id, north: "north" },
      p.cells({ box: [0, 0, 0, 3, 5, 3] }),
    ) as Piece;
    const q = new Project({ chunkBits: 4 });
    const r = q.run(cmd("paste", { piece, at: [0, 0, 0] }));
    expect(r.report.created.palettes).toHaveLength(1);
    expect(q.semantics.paletteByName("Walkway")).toBeDefined();
    const wall = q.semantics.byName("Wall", ROOT_PALETTE) as number;
    expect(q.semantics.resolve(wall).look.block).toBe("mc:stone");
    expect(describeCells(q)).toEqual(describeCells(p));
    // A second paste reuses what the first created.
    const again = q.run(cmd("paste", { piece, at: [10, 0, 0] }));
    expect(again.report.created.semantics).toEqual([]);
  });

  it("maps semantics explicitly when asked", () => {
    const { p } = build();
    const piece = cutPiece(
      { world: p.world, semantics: p.semantics, north: "north" },
      p.cells({ box: [0, 0, 0, 0, 0, 0] }),
    ) as Piece;
    const q = new Project({ chunkBits: 4 });
    const brick = q.semantics.add("Brick");
    q.run(cmd("paste", { piece, at: [0, 0, 0], map: { "1": brick } }));
    expect(q.world.get(0, 0, 0)?.semantic).toBe(brick);
    expect(q.semantics.size).toBe(1);
  });

  it("keeps north north from one project to another and back", () => {
    const { p: a } = build("east");
    const pieceA = cutPiece(
      { world: a.world, semantics: a.semantics, north: a.settings.north },
      a.cells({ box: [0, 0, 0, 3, 3, 3] }),
    ) as Piece;
    const b = new Project({ chunkBits: 4 }); // north is -Z
    const r = b.run(cmd("paste", { piece: pieceA, at: [0, 0, 0] }));
    expect(r.report.notes.turned).toBe(3);
    // The same cells pasted with no north to honour would need that turn by hand.
    const manual = new Project({ chunkBits: 4 });
    manual.run(cmd("paste", { piece: { ...pieceA, north: "north" }, at: [0, 0, 0], turn: 3 }));
    expect(describeCells(b)).toEqual(describeCells(manual));
    // And back into a project facing east: exactly as it was.
    const pieceB = cutPiece(
      { world: b.world, semantics: b.semantics, north: b.settings.north },
      b.cells({ box: [-10, -10, -10, 10, 10, 10] }),
    ) as Piece;
    const c = new Project({ chunkBits: 4 });
    c.run(cmd("settings", { north: "east" }));
    c.run(cmd("paste", { piece: pieceB, at: [0, 0, 0] }));
    expect(describeCells(c)).toEqual(describeCells(a));
  });

  it("turning commutes with pasting", () => {
    const { p } = build();
    const piece = cutPiece(
      { world: p.world, semantics: p.semantics, north: "north" },
      p.cells({ box: [0, 0, 0, 3, 3, 3] }),
    ) as Piece;
    for (const [turn, mirror] of [[1], [2], [3], [0, "x"], [1, "z"]] as const) {
      const a = new Project({ chunkBits: 4 });
      a.run(cmd("paste", { piece, at: [0, 0, 0], turn, ...(mirror && { mirror }) }));
      const b = new Project({ chunkBits: 4 });
      b.run(cmd("paste", { piece, at: [0, 0, 0] }));
      b.run(
        cmd("transform", {
          where: { box: [-5, -5, -5, 5, 5, 5] },
          turn,
          ...(mirror && { mirror }),
        }),
      );
      expect(describeCells(a)).toEqual(describeCells(b));
    }
  });

  it("pastes air only when asked", () => {
    const { p } = build();
    const piece = cutPiece(
      { world: p.world, semantics: p.semantics, id: p.id, north: "north" },
      p.cells({ box: [0, 0, 1, 1, 0, 1] }),
    ) as Piece;
    expect(piece.states).toEqual([null]);
    const q = new Project({ chunkBits: 4 });
    q.semantics.add("Wall");
    q.run(cmd("fill", { where: { box: [0, 0, 0, 3, 0, 3] }, state: { semantic: 1 } }));
    q.run(cmd("paste", { piece, at: [0, 0, 0] }));
    expect(q.world.cellCount).toBe(16);
    q.run(cmd("paste", { piece, at: [0, 0, 0], air: true }));
    expect(q.world.cellCount).toBe(14);
  });

  it("refuses a malformed piece without changing anything", () => {
    const q = new Project({ chunkBits: 4 });
    const bad = { size: [1, 1, 1], north: "north", semantics: [], states: [null], cells: [1, 5] };
    expect(() => q.run(cmd("paste", { piece: bad, at: [0, 0, 0] }))).toThrow(/past its box/);
  });
});

describe("prefabs", () => {
  it("round-trip through the project format, pinned by a content hash", async () => {
    const { p } = build();
    const piece = cutPiece(
      { world: p.world, semantics: p.semantics, north: "east" },
      p.cells({ box: [0, 0, 0, 3, 3, 3] }),
      [1, 0, 0],
    ) as Piece;
    const saved = await savePrefab(piece, "Corner Kit");
    expect(saved.manifest.settings.name).toBe("Corner Kit");
    const bundle = await unpackBundle(await packBundle(saved));
    const hash = prefabHash(bundle);
    expect(hash).toBe(prefabHash(saved));
    expect(prefabHash(await savePrefab(piece, "Renamed"))).toBe(hash);
    expect(prefabHash(await savePrefab({ ...piece, anchor: [0, 0, 0] }, "x"))).not.toBe(hash);

    const loaded = await loadPrefab(bundle);
    expect(loaded.anchor).toEqual([1, 0, 0]);
    expect(loaded.north).toBe("east");
    const prefabs = new Map([[hash, loaded]]);
    const a = new Project({ chunkBits: 4, prefabs: (h) => prefabs.get(h) });
    a.run(cmd("paste", { prefab: hash, at: [5, 0, 5] }));
    const b = new Project({ chunkBits: 4 });
    b.run(cmd("paste", { piece, at: [5, 0, 5] }));
    expect(describeCells(a, false)).toEqual(describeCells(b, false));
    // A host that hasn't loaded the prefab gets a clear error.
    expect(() => b.run(cmd("paste", { prefab: "0123456789abcdef", at: [0, 0, 0] }))).toThrow(
      /isn't loaded/,
    );
  });
});

describe("settings", () => {
  it("are a command: undoable, and they move no cells", () => {
    const { p } = build();
    const cells = describeCells(p, false);
    p.run(cmd("settings", { name: "Hall", north: "west", grid: [4, 8] }));
    expect(p.settings).toEqual({ name: "Hall", north: "west", grid: [4, 8], note: "" });
    expect(describeCells(p, false)).toEqual(cells);
    p.run(cmd("undo", { target: p.undoTarget() }));
    expect(p.settings.north).toBe("north");
    expect(() => p.run(cmd("settings", { grid: [16, 0] }))).toThrow();
  });
});
