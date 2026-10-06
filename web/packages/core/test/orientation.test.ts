import { describe, expect, it } from "vitest";
import {
  type Command,
  CommandError,
  compilePlacement,
  facingOf,
  PLACEMENTS,
  type PlacementProfile,
  Project,
  parseRegionText,
  RegionTextError,
  ROOT_PALETTE,
  regionStats,
  regionText,
  rotationOf,
  sideOf,
  upOf,
} from "../src/index.ts";

let n = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `o${n++}`, kind, args });

const facing = (r: number) => sideOf(facingOf(r));
const up = (r: number) => sideOf(upOf(r));

describe("placement profiles", () => {
  it("allow the rotations Minecraft's blocks have", () => {
    const counts = Object.fromEntries(
      Object.entries(PLACEMENTS).map(([k, p]) => [k, compilePlacement(p).allowed.length]),
    );
    expect(counts).toEqual({
      cube: 1,
      horizontal: 4,
      stairs: 8,
      slab: 2,
      log: 3,
      facing: 6,
      torch: 5,
      hopper: 5,
    });
    expect(compilePlacement().allowed.length).toBe(24);
  });

  it("fix any rotation to an allowed, canonical one, and leave allowed ones alone", () => {
    for (const profile of Object.values(PLACEMENTS) as PlacementProfile[]) {
      const p = compilePlacement(profile);
      for (let r = 0; r < 24; r++) {
        const f = p.fix(r);
        expect(p.allowed).toContain(f);
        expect(p.fix(f)).toBe(f);
        if (p.allows(r)) expect(p.fix(r)).toBe(p.fix(f));
      }
    }
    // A stair tipped onto its back snaps to the nearest upright or upside-down stair.
    const stairs = compilePlacement(PLACEMENTS.stairs);
    const tipped = rotationOf("up", "south");
    expect(["up", "down"]).toContain(up(stairs.fix(tipped)));
  });

  it("pick rotations from clicks", () => {
    const lookNorth = [0, -0.3, -1] as const;
    const stairs = compilePlacement(PLACEMENTS.stairs);
    // A stair's front faces the player; the upper half of a side face turns it upside down.
    const low = stairs.pick({ face: [0, 0, 1], look: lookNorth, hitY: 0.2 });
    expect([facing(low), up(low)]).toEqual(["south", "up"]);
    const high = stairs.pick({ face: [0, 0, 1], look: lookNorth, hitY: 0.8 });
    expect([facing(high), up(high)]).toEqual(["south", "down"]);
    expect(up(stairs.pick({ face: [0, -1, 0], look: lookNorth }))).toBe("down");
    // A torch hangs on the face clicked, never from a ceiling.
    const torch = compilePlacement(PLACEMENTS.torch);
    expect(up(torch.pick({ face: [1, 0, 0], look: [-1, 0, 0] }))).toBe("east");
    expect(up(torch.pick({ face: [0, -1, 0], look: [0, 1, 0] }))).not.toBe("down");
    expect(torch.attachedTo(torch.pick({ face: [1, 0, 0], look: [-1, 0, 0] }))).toBe("west");
    expect(stairs.attachedTo(low)).toBe(null);
    // A hopper points into the block clicked; a log lies along the clicked face's axis.
    const hopper = compilePlacement(PLACEMENTS.hopper);
    expect(facing(hopper.pick({ face: [0, 1, 0], look: [0, -1, 0] }))).toBe("down");
    expect(facing(hopper.pick({ face: [-1, 0, 0], look: [1, 0, 0] }))).toBe("east");
    const log = compilePlacement(PLACEMENTS.log);
    expect(["east", "west"]).toContain(up(log.pick({ face: [1, 0, 0], look: [-1, 0, 0] })));
    // Nothing to pick: a cube.
    expect(compilePlacement(PLACEMENTS.cube).pick({ face: [0, 1, 0], look: lookNorth })).toBe(0);
  });

  it("refuse profiles that allow nothing", () => {
    const p = new Project();
    expect(() =>
      p.run(
        cmd("semantic_add", {
          name: "Impossible",
          form: { placement: { front: ["up"], up: ["up"] } },
        }),
      ),
    ).toThrow(CommandError);
  });
});

/** A project with a stair, a cube, a log and a free semantic. */
function project() {
  const p = new Project({ chunkBits: 4 });
  const add = (name: string, placement?: PlacementProfile) =>
    p.run(cmd("semantic_add", { name, ...(placement && { form: { placement } }) })).report.created
      .semantics[0] as number;
  return {
    p,
    stair: add("Stair", PLACEMENTS.stairs),
    cube: add("Cube", PLACEMENTS.cube),
    log: add("Log", PLACEMENTS.log),
    free: add("Free"),
  };
}

describe("rotations in cells", () => {
  it("are stored fixed to the semantic's profile", () => {
    const { p, stair, cube } = project();
    const east = rotationOf("east");
    p.run(
      cmd("set", {
        states: [
          { semantic: cube, rotation: east },
          { semantic: stair, rotation: rotationOf("up", "south") },
        ],
        cells: [0, 0, 0, 0, 1, 0, 0, 1],
      }),
    );
    expect(p.world.get(0, 0, 0)?.rotation).toBe(0);
    expect(compilePlacement(PLACEMENTS.stairs).allows(p.world.get(1, 0, 0)?.rotation ?? -1)).toBe(
      true,
    );
  });

  it("keep a turned build of cubes to one state per semantic", () => {
    const { p, cube } = project();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 3, 3, 3] }, state: { semantic: cube } }));
    const states = p.world.states.size;
    p.run(cmd("transform", { where: { box: [0, 0, 0, 3, 3, 3] }, turn: 1 }));
    p.run(cmd("copy", { where: { box: [0, 0, 0, 3, 3, 3] }, to: [10, 0, 0], mirror: "x" }));
    expect(p.world.states.size).toBe(states);
  });
});

describe("rotate", () => {
  it("turns stairs clockwise on a face, stepping past rotations they can't take", () => {
    const { p, stair, cube } = project();
    p.run(
      cmd("set", {
        states: [{ semantic: stair }, { semantic: cube }],
        cells: [0, 0, 0, 0, 1, 0, 0, 1],
      }),
    );
    const at = (x: number) => p.world.get(x, 0, 0)?.rotation ?? -1;
    let r = p.run(cmd("rotate", { where: { box: [0, 0, 0, 1, 0, 0] }, face: "up" }));
    expect(facing(at(0))).toBe("east");
    expect(r.report.notes).toMatchObject({ rotated: 1, unchanged: 1 });
    expect(at(1)).toBe(0);
    p.run(cmd("rotate", { where: { box: [0, 0, 0, 0, 0, 0] }, face: "up", turns: -1 }));
    expect(facing(at(0))).toBe("north");
    // About a side axis a stair can't lie on its back: it lands upside down instead.
    r = p.run(cmd("rotate", { where: { box: [0, 0, 0, 0, 0, 0] }, face: "east" }));
    expect([facing(at(0)), up(at(0))]).toEqual(["south", "down"]);
    p.run(cmd("undo", { target: p.undoTarget() }));
    expect([facing(at(0)), up(at(0))]).toEqual(["north", "up"]);
  });

  it("lays a log down and turns parts slot by slot", () => {
    const { p, log, free } = project();
    p.run(
      cmd("set", {
        states: [
          { semantic: log },
          { parts: [{ semantic: free, shape: "face1", slot: 2 }] },
          { parts: [{ semantic: free, shape: "roof_tile", slot: 0 }] },
        ],
        cells: [0, 0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2],
      }),
    );
    p.run(cmd("rotate", { where: { box: [0, 0, 0, 2, 0, 0] }, face: "north" }));
    expect(["east", "west"]).toContain(up(p.world.get(0, 0, 0)?.rotation ?? 0));
    expect(p.world.get(1, 0, 0)?.parts[0]?.slot).toBe(2); // a north cover turned about north
    p.run(cmd("rotate", { where: { box: [0, 0, 0, 2, 0, 0] }, face: "up", turns: 2 }));
    expect(p.world.get(1, 0, 0)?.parts[0]?.slot).toBe(3); // now on the south side
    expect(p.world.get(2, 0, 0)?.parts[0]?.slot).not.toBe(0);
  });
});

describe("resemantic and shape rules", () => {
  it("snaps rotations the target can't take, and counts them", () => {
    const { p, stair, free } = project();
    const tipped = rotationOf("up", "south");
    p.run(
      cmd("fill", {
        where: { box: [0, 0, 0, 2, 0, 0] },
        state: { semantic: free, rotation: tipped },
      }),
    );
    const r = p.run(
      cmd("resemantic", { where: { box: [0, 0, 0, 2, 0, 0] }, from: free, to: stair }),
    );
    expect(r.report.notes).toMatchObject({ switched: 3, fixed: 3 });
    expect(["up", "down"]).toContain(up(p.world.get(0, 0, 0)?.rotation ?? 0));
  });

  it("refuses parts that can't share a cell", () => {
    const { p, free, cube } = project();
    expect(() =>
      p.run(
        cmd("set", {
          states: [
            {
              parts: [
                { semantic: free, shape: "face1", slot: 0 },
                { semantic: cube, shape: "face2", slot: 0 },
              ],
            },
          ],
          cells: [0, 0, 0, 0],
        }),
      ),
    ).toThrow(/slot_taken/);
    expect(() =>
      p.run(
        cmd("set", {
          states: [{ parts: [{ semantic: free, shape: "mystery", slot: 0 }] }],
          cells: [0, 0, 0, 0],
        }),
      ),
    ).toThrow(/invalid_slot/);
    expect(p.world.cellCount).toBe(0);
  });
});

describe("region stats", () => {
  it("count blocks, parts and materials, merging semantics that share a block", () => {
    const p = new Project({ chunkBits: 4 });
    const a = p.semantics.add("Floor", { look: { block: "mc:stone" } });
    const b = p.semantics.add("Wall", { look: { block: "mc:stone" } });
    const c = p.semantics.add("Trim", { form: { shape: "edge1" } });
    p.run(cmd("fill", { where: { box: [0, 0, 0, 4, 0, 4] }, state: { semantic: a } }));
    p.run(cmd("fill", { where: { box: [0, 1, 0, 0, 3, 0] }, state: { semantic: b } }));
    p.run(
      cmd("set", {
        states: [{ parts: [{ semantic: c, shape: "edge1", slot: 0 }] }],
        cells: [4, 1, 4, 0, 4, 2, 4, 0],
      }),
    );
    const all = regionStats(p);
    expect(all.cells).toBe(25 + 3 + 2);
    expect(all.bounds).toEqual({ x0: 0, y0: 0, z0: 0, x1: 4, y1: 3, z1: 4 });
    expect(all.blocks).toEqual([
      { semantic: a, name: "Floor", count: 25 },
      { semantic: b, name: "Wall", count: 3 },
    ]);
    expect(all.parts).toEqual([{ semantic: c, name: "Trim", shape: "edge1", count: 2 }]);
    expect(all.materials).toEqual([
      { block: "mc:stone", shape: null, count: 28, semantics: [a, b] },
      { block: null, shape: "edge1", count: 2, semantics: [c] },
    ]);
    const some = regionStats(p, { semantic: b });
    expect(some.cells).toBe(3);
    expect(some.bounds).toEqual({ x0: 0, y0: 1, z0: 0, x1: 0, y1: 3, z1: 0 });
  });
});

describe("region text", () => {
  /** A small build with rotations, tags, parts and same-named semantics in two palettes. */
  function build() {
    const p = new Project({ chunkBits: 4 });
    const deck = p.semantics.add("Deck");
    const rail = p.semantics.add("Rail", { form: { shape: "edge1" } });
    const walkway =
      p.run(cmd("palette_add", { name: "Walkway", extends: ROOT_PALETTE })).report.created
        .palettes[0] ?? 0;
    const stair = p.semantics.add("Stair", { form: { placement: PLACEMENTS.stairs } });
    p.run(cmd("fill", { where: { box: [0, 0, 0, 3, 0, 2] }, state: { semantic: deck } }));
    p.run(
      cmd("set", {
        states: [
          { semantic: { palette: walkway, base: deck } },
          { semantic: stair, rotation: rotationOf("east", "down") },
          { semantic: deck, tags: { note: "hi" } },
          {
            parts: [
              { semantic: rail, shape: "edge1", slot: 0 },
              { semantic: deck, shape: "face1", slot: 1 },
            ],
          },
        ],
        cells: [0, 1, 0, 0, 1, 1, 0, 1, 2, 1, 0, 2, 3, 1, 2, 3],
      }),
    );
    return p;
  }

  it("writes a build and reads it back to the same cells", () => {
    const p = build();
    for (const axis of ["y", "z", "x"] as const) {
      const text = regionText(p, { box: [0, 0, 0, 3, 1, 2] }, axis);
      const copy = p.fork();
      copy.run(cmd("clear", { where: { box: [0, 0, 0, 3, 1, 2] } }));
      copy.run(cmd("set", parseRegionText(copy, text)));
      const dump = (q: Project) => {
        const out: string[] = [];
        q.world.forEachCell((x, y, z, id) => out.push(`${x},${y},${z}:${id}`));
        return out.sort();
      };
      expect(dump(copy)).toEqual(dump(p));
    }
  });

  it("reads like a plan, with letters from the semantics' names", () => {
    const p = build();
    const text = regionText(p, { box: [0, 0, 0, 3, 1, 2] });
    expect(text.layers[0]).toEqual(["DDDD", "DDDD", "DDDD"]);
    expect(text.legend.D).toEqual({ semantic: "Deck", palette: "Main" });
    expect(text.layers[1]).toEqual(["ESC.", "....", "...r"]);
    expect(text.legend.E).toEqual({ semantic: "Deck", palette: "Walkway" });
    expect(text.legend.C).toEqual({ semantic: "Deck", palette: "Main", tags: { note: "hi" } });
    expect(text.legend.S).toEqual({ semantic: "Stair", facing: "east", up: "down" });
    const parts = Object.values(text.legend).find(Array.isArray);
    expect(parts).toEqual([
      { semantic: "Rail", slot: "north-west" },
      { semantic: "Deck", palette: "Main", shape: "face1", slot: "up" },
    ]);
  });

  it("lists every problem in a text", () => {
    const p = build();
    try {
      parseRegionText(p, {
        origin: [0, 0, 0],
        legend: { A: "Nothing", B: "Deck", C: [{ semantic: "Rail", slot: "sideways" }] },
        layers: [["ABCZ_."]],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RegionTextError);
      const problems = (error as RegionTextError).problems.join("\n");
      expect(problems).toMatch(/no semantic named "Nothing"/);
      expect(problems).toMatch(/several palettes/);
      expect(problems).toMatch(/no slot "sideways"/);
      expect(problems).toMatch(/'Z' isn't in the legend/);
    }
    // A palette tells same-named semantics apart; "_" clears and "." leaves cells alone.
    const set = parseRegionText(p, {
      origin: [0, 0, 0],
      legend: { W: { semantic: "Deck", palette: "Main" } },
      layers: ["W_."],
    });
    expect(set.states).toEqual([{ semantic: 1 }, null]);
    expect(set.cells).toEqual([0, 0, 0, 0, 1, 0, 0, 1]);
  });
});
