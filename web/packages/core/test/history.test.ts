import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Command, CommandError, Project, type World } from "../src/index.ts";

let n = 0;
const cmd = (kind: string, args: unknown, extra: Partial<Command> = {}): Command => ({
  id: `h${n++}`,
  kind,
  args,
  ...extra,
});

function dump(p: Project): string {
  const cells: string[] = [];
  const world: World = p.world;
  world.forEachCell((x, y, z, id) =>
    cells.push(`${x},${y},${z}=${JSON.stringify(world.states.get(id))}`),
  );
  const names = [...p.semantics].map((s) => `${s.id}:${p.semantics.nameOf(s.id)}`);
  return `${cells.sort().join(";")}|${names.join(",")}|${p.world.cellCount}`;
}

const undo = (p: Project) => p.run(cmd("undo", { target: p.undoTarget() }));
const redo = (p: Project) => p.run(cmd("redo", { target: p.redoTarget() }));

function project() {
  const p = new Project({ chunkBits: 4 });
  const floor = p.semantics.add("Floor");
  const wall = p.semantics.add("Wall");
  return { p, floor, wall };
}

describe("history", () => {
  it("undoes and redoes back through every state, as commands in the log", () => {
    const coord = fc.integer({ min: -12, max: 12 });
    const box = fc.tuple(coord, coord, coord, coord, coord, coord);
    const step = fc.oneof(
      fc.record({ kind: fc.constant("fill"), box, semantic: fc.integer({ min: 1, max: 2 }) }),
      fc.record({ kind: fc.constant("clear"), box }),
      fc.record({
        kind: fc.constant("rename"),
        semantic: fc.integer({ min: 1, max: 2 }),
        name: fc.string({ minLength: 1, maxLength: 6 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 10 }), (steps) => {
        const { p } = project();
        const states = [dump(p)];
        for (const s of steps) {
          try {
            if (s.kind === "fill")
              p.run(cmd("fill", { where: { box: s.box }, state: { semantic: s.semantic } }));
            else if (s.kind === "clear") p.run(cmd("clear", { where: { box: s.box } }));
            else
              p.run(
                cmd("semantic_update", { semantic: s.semantic, name: `${s.name}${s.semantic}` }),
              );
          } catch (error) {
            if (!(error instanceof CommandError)) throw error; // e.g. a blank name: not applied
            continue;
          }
          states.push(dump(p));
        }
        for (let i = states.length - 2; i >= 0; i--) {
          undo(p);
          expect(dump(p)).toBe(states[i]);
        }
        expect(p.undoTarget()).toBeNull();
        for (let i = 1; i < states.length; i++) {
          redo(p);
          expect(dump(p)).toBe(states[i]);
        }
        expect(p.redoTarget()).toBeNull();
      }),
      { numRuns: 50 },
    );
  });

  it("drops the redo branch when a new edit comes after an undo", () => {
    const { p, floor, wall } = project();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 3, 0, 0] }, state: { semantic: floor } }));
    undo(p);
    expect(p.redoTarget()).not.toBeNull();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 1, 0, 0] }, state: { semantic: wall } }));
    expect(p.redoTarget()).toBeNull();
    expect(p.history.map((e) => e.state)).toEqual(["dead", "active", "active"]);
  });

  it("undoes a group as one step, skipping selections in between", () => {
    const { p, floor, wall } = project();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 0, 0, 0] }, state: { semantic: floor } }));
    const before = dump(p);
    p.run(
      cmd(
        "fill",
        { where: { box: [1, 0, 0, 1, 0, 0] }, state: { semantic: wall } },
        { group: "task" },
      ),
    );
    p.run(cmd("select", { where: { box: [0, 0, 0, 9, 9, 9] } }));
    p.run(
      cmd(
        "fill",
        { where: { box: [2, 0, 0, 2, 0, 0] }, state: { semantic: wall } },
        { group: "task" },
      ),
    );
    const r = undo(p);
    expect(r.report.cells).toBe(2);
    expect(dump(p)).toBe(before);
    expect(p.selection?.size).toBe(1000); // selection isn't an undo step
    redo(p);
    expect(p.world.cellCount).toBe(3);
  });

  it("refuses an undo naming the wrong step, and ignores a repeated undo", () => {
    const { p, floor } = project();
    const first = cmd("fill", { where: { box: [0, 0, 0, 0, 0, 0] }, state: { semantic: floor } });
    p.run(first);
    p.run(cmd("fill", { where: { box: [1, 0, 0, 1, 0, 0] }, state: { semantic: floor } }));
    expect(() => p.run(cmd("undo", { target: first.id }))).toThrow(CommandError);
    expect(p.world.cellCount).toBe(2);
    // ChatGPT sends tool calls twice: the same undo command, twice, undoes once.
    const once = cmd("undo", { target: p.undoTarget() });
    p.run(once);
    expect(p.run(once).status).toBe("duplicate");
    expect(p.world.cellCount).toBe(1);
  });

  it("logs undo and redo as entries that aren't steps themselves", () => {
    const { p, floor } = project();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 0, 0, 0] }, state: { semantic: floor } }));
    undo(p);
    redo(p);
    expect(p.history.map((e) => `${e.command.kind}:${e.undoable}:${e.state}`)).toEqual([
      "fill:true:active",
      "undo:false:active",
      "redo:false:active",
    ]);
    expect(p.undoTarget()).toBe(p.history[0]?.command.id);
  });
});
