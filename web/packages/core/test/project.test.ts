import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Command, CommandError, EMPTY_ID, Project, type World } from "../src/index.ts";

/** Every occupied cell as "x,y,z" -> state, for comparing worlds. */
function dump(world: World): Map<string, string> {
  const cells = new Map<string, string>();
  world.forEachCell((x, y, z, id) =>
    cells.set(`${x},${y},${z}`, JSON.stringify(world.states.get(id))),
  );
  return cells;
}

let nextId = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `c${nextId++}`, kind, args });

function project() {
  const p = new Project({ chunkBits: 4 });
  const floor = p.semantics.add("Floor", { description: "The hall floor" });
  const wall = p.semantics.add("Wall");
  return { p, floor, wall };
}

describe("Project.run", () => {
  it("fills, clears and sets, reporting counts per semantic and the changed box", () => {
    const { p, floor, wall } = project();
    const filled = p.run(
      cmd("fill", { where: { box: [9, 0, 9, 0, 0, 0] }, state: { semantic: floor } }),
    );
    expect(filled.status).toBe("applied");
    expect(filled.report.cells).toBe(100);
    expect(filled.report.bounds).toEqual({ x0: 0, y0: 0, z0: 0, x1: 9, y1: 0, z1: 9 });
    expect(filled.report.semantics).toEqual([
      { semantic: floor, name: "Floor", before: 0, after: 100 },
    ]);

    const set = p.run(
      cmd("set", {
        states: [{ semantic: wall }, null],
        cells: [0, 0, 0, 0, 1, 0, 0, 1, 5, 5, 5, 1],
      }),
    );
    expect(set.report.cells).toBe(2); // the empty cell at 5,5,5 stays empty
    expect(set.report.semantics).toEqual([
      { semantic: floor, name: "Floor", before: 2, after: 0 },
      { semantic: wall, name: "Wall", before: 0, after: 1 },
    ]);
    expect(p.world.cellCount).toBe(99);

    const cleared = p.run(cmd("clear", { where: { box: [0, 0, 0, 20, 20, 20] } }));
    expect(cleared.report.cells).toBe(99);
    expect(p.world.cellCount).toBe(0);
  });

  it("reports whole bricks without visiting their cells, with the same totals", () => {
    const { p, floor } = project();
    const r = p.run(
      cmd("fill", { where: { box: [0, 0, 0, 47, 47, 47] }, state: { semantic: floor } }),
    );
    expect(r.report.cells).toBe(48 ** 3);
    expect(r.report.semantics[0]?.after).toBe(48 ** 3);
  });

  it("acknowledges a repeated id without applying it again", () => {
    const { p, floor } = project();
    const once = cmd("fill", { where: { box: [0, 0, 0, 3, 0, 0] }, state: { semantic: floor } });
    expect(p.run(once).status).toBe("applied");
    p.run(cmd("clear", { where: { box: [0, 0, 0, 3, 0, 0] } }));
    const again = p.run(once);
    expect(again.status).toBe("duplicate");
    expect(again.report.cells).toBe(4);
    expect(p.world.cellCount).toBe(0);
  });

  it("rejects bad commands without changing anything, even halfway through", () => {
    const { p, floor } = project();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 3, 3, 3] }, state: { semantic: floor } }));
    const before = dump(p.world);
    expect(() => p.run(cmd("explode", {}))).toThrow(CommandError);
    expect(() =>
      p.run(cmd("fill", { where: { box: [0, 0, 0] }, state: { semantic: floor } })),
    ).toThrow(CommandError);
    expect(() =>
      p.run(cmd("fill", { where: { box: [0, 0, 0, 1, 1, 1] }, state: { semantic: 99 } })),
    ).toThrow(CommandError);
    // Writes some cells, then hits a bad state index: the first writes are undone.
    expect(() =>
      p.run(cmd("set", { states: [null], cells: [0, 0, 0, 0, 1, 1, 1, 0, 2, 2, 2, 7] })),
    ).toThrow(CommandError);
    expect(dump(p.world)).toEqual(before);
  });

  it("previews on a fork and leaves the project alone", () => {
    const { p, floor } = project();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 3, 0, 3] }, state: { semantic: floor } }));
    const before = dump(p.world);
    const { project: fork, report } = p.preview(
      cmd("clear", { where: { box: [0, 0, 0, 1, 0, 1] } }),
    );
    expect(report.cells).toBe(4);
    expect(fork.world.cellCount).toBe(12);
    expect(dump(p.world)).toEqual(before);
    // And the project's later writes don't leak into the fork.
    p.run(cmd("clear", { where: { box: [0, 0, 0, 3, 0, 3] } }));
    expect(fork.world.cellCount).toBe(12);
  });

  it("renames a semantic without touching a cell", () => {
    const { p, floor } = project();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 3, 0, 3] }, state: { semantic: floor } }));
    const before = dump(p.world);
    p.semantics.rename(floor, "Hall floor");
    expect(dump(p.world)).toEqual(before);
    expect(p.semantics.nameOf(floor)).toBe("Hall floor");
    expect(p.semantics.byName("Floor")).toBeUndefined();
  });
});

// Random commands over a small space, for the replay and undo properties.
const coord = fc.integer({ min: -20, max: 20 });
const box = fc.tuple(coord, coord, coord, coord, coord, coord);
const anyCommand = fc.oneof(
  fc.record({
    kind: fc.constant("fill"),
    box,
    semantic: fc.integer({ min: 1, max: 2 }),
    rotation: fc.nat(23),
  }),
  fc.record({ kind: fc.constant("clear"), box }),
  fc.record({
    kind: fc.constant("set"),
    cells: fc.array(fc.tuple(coord, coord, coord, fc.integer({ min: 0, max: 2 })), {
      maxLength: 20,
    }),
  }),
);
type Random = typeof anyCommand extends fc.Arbitrary<infer T> ? T : never;

function toCommand(r: Random, i: number): Command {
  if (r.kind === "fill") {
    return {
      id: `r${i}`,
      kind: "fill",
      args: { where: { box: r.box }, state: { semantic: r.semantic, rotation: r.rotation } },
    };
  }
  if (r.kind === "clear") return { id: `r${i}`, kind: "clear", args: { where: { box: r.box } } };
  return {
    id: `r${i}`,
    kind: "set",
    args: { states: [null, { semantic: 1 }, { semantic: 2, rotation: 5 }], cells: r.cells.flat() },
  };
}

describe("commands", () => {
  it("are deterministic: replaying the same commands gives the same world", () => {
    fc.assert(
      fc.property(fc.array(anyCommand, { maxLength: 12 }), (randoms) => {
        const [a, b] = [project().p, project().p];
        randoms.forEach((r, i) => {
          a.run(toCommand(r, i));
          b.run(toCommand(r, i));
        });
        expect(dump(b.world)).toEqual(dump(a.world));
      }),
      { numRuns: 60 },
    );
  });

  it("can be undone and redone exactly from their recorded edits", () => {
    fc.assert(
      fc.property(fc.array(anyCommand, { minLength: 1, maxLength: 12 }), (randoms) => {
        const { p } = project();
        const states: Map<string, string>[] = [dump(p.world)];
        randoms.forEach((r, i) => {
          p.run(toCommand(r, i));
          states.push(dump(p.world));
        });
        const applied = p.applied;
        for (let i = applied.length - 1; i >= 0; i--) {
          p.world.restore(applied[i]?.edit.before ?? new Map());
          expect(dump(p.world)).toEqual(states[i]);
        }
        for (let i = 0; i < applied.length; i++) {
          p.world.restore(applied[i]?.edit.after ?? new Map());
          expect(dump(p.world)).toEqual(states[i + 1]);
        }
        let count = 0;
        p.world.forEachCell((_x, _y, _z, id) => {
          if (id !== EMPTY_ID) count++;
        });
        expect(p.world.cellCount).toBe(count);
      }),
      { numRuns: 60 },
    );
  });
});
