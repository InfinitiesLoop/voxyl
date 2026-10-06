import { describe, expect, it } from "vitest";
import { type Command, CommandError, Project, ROOT_PALETTE, type World } from "../src/index.ts";

let n = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `p${n++}`, kind, args });

function dump(world: World): Map<string, string> {
  const cells = new Map<string, string>();
  world.forEachCell((x, y, z, id) =>
    cells.set(`${x},${y},${z}`, JSON.stringify(world.states.get(id))),
  );
  return cells;
}

function factory() {
  const p = new Project({ chunkBits: 4 });
  p.run(cmd("semantic_add", { name: "Deck", look: { block: "ztones:zane" } }));
  p.run(cmd("semantic_add", { name: "Rail", form: { shape: "edge1" } }));
  const added = p.run(cmd("palette_add", { name: "Walkway", extends: ROOT_PALETTE }));
  const deck = p.semantics.byName("Deck", ROOT_PALETTE) ?? 0;
  const rail = p.semantics.byName("Rail", ROOT_PALETTE) ?? 0;
  const walkway = added.report.created.palettes[0] ?? 0;
  return { p, deck, rail, walkway };
}

describe("palette and semantic commands", () => {
  it("derive a semantic on first placement and report it as created", () => {
    const { p, deck, walkway } = factory();
    const first = p.run(
      cmd("fill", {
        where: { box: [0, 0, 0, 3, 0, 0] },
        state: { semantic: { palette: walkway, base: deck } },
      }),
    );
    expect(first.report.created.semantics).toHaveLength(1);
    const wDeck = first.report.created.semantics[0] ?? 0;
    expect(p.semantics.resolve(wDeck)).toMatchObject({ name: "Deck", palette: walkway });
    const again = p.run(
      cmd("fill", {
        where: { box: [0, 1, 0, 3, 1, 0] },
        state: { semantic: { palette: walkway, base: deck } },
      }),
    );
    expect(again.report.created.semantics).toEqual([]);
    expect(p.semantics.semanticsIn(walkway)).toEqual([wDeck]);
  });

  it("re-skin a palette without changing a single cell (principle 3)", () => {
    const { p, deck, walkway } = factory();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 7, 0, 7] }, state: { semantic: deck } }));
    p.run(
      cmd("fill", {
        where: { box: [0, 1, 0, 7, 1, 7] },
        state: { semantic: { palette: walkway, base: deck } },
      }),
    );
    const cells = dump(p.world);
    const r = p.run(cmd("semantic_update", { semantic: deck, look: { block: "minecraft:stone" } }));
    expect(r.report.cells).toBe(0);
    expect(r.report.registryChanged).toBe(true);
    expect(dump(p.world)).toEqual(cells);
    const wDeck = p.semantics.byName("Deck", walkway) ?? 0;
    expect(p.semantics.resolve(wDeck).look.block).toBe("minecraft:stone");
  });

  it("roll registry changes back when a command fails", () => {
    const { p, walkway, deck } = factory();
    const palettes = p.semantics.palettes().length;
    const size = p.semantics.size;
    expect(() => p.run(cmd("palette_add", { name: "Bad", extends: 99 }))).toThrow(CommandError);
    expect(() => p.run(cmd("semantic_add", { name: "Deck" }))).toThrow(CommandError);
    // Derives a semantic, then fails on a bad state index: the derived semantic goes too.
    expect(() =>
      p.run(
        cmd("set", {
          states: [{ semantic: { palette: walkway, base: deck } }],
          cells: [0, 0, 0, 0, 1, 0, 0, 3],
        }),
      ),
    ).toThrow(CommandError);
    expect(p.semantics.palettes().length).toBe(palettes);
    expect(p.semantics.size).toBe(size);
    expect(p.semantics.semanticsIn(walkway)).toEqual([]);
  });

  it("keep registry snapshots for undo", () => {
    const { p, deck } = factory();
    p.run(cmd("semantic_update", { semantic: deck, name: "Floor" }));
    const last = p.applied.at(-1);
    expect(last?.registry).not.toBeNull();
    p.semantics.restore(last?.registry?.before ?? p.semantics);
    expect(p.semantics.nameOf(deck)).toBe("Deck");
  });
});

describe("resemantic", () => {
  it("switches blocks and parts, keeping rotation, shapes and slots", () => {
    const { p, deck, walkway } = factory();
    const walk =
      p.run(cmd("semantic_add", { name: "Walk", palette: walkway })).report.created.semantics[0] ??
      0;
    p.run(
      cmd("set", {
        states: [
          { semantic: deck, rotation: 5 },
          {
            parts: [
              { semantic: deck, shape: "face1", slot: 0 },
              { semantic: walk, shape: "face1", slot: 1 },
            ],
          },
        ],
        cells: [0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1],
      }),
    );
    const r = p.run(
      cmd("resemantic", { where: { box: [0, 0, 0, 9, 9, 9] }, from: deck, to: walk }),
    );
    expect(r.report.notes).toEqual({ switched: 3, skipped: 0 });
    expect(p.world.get(1, 0, 0)).toMatchObject({ semantic: walk, rotation: 5 });
    expect(p.world.get(2, 0, 0)?.parts).toEqual([
      { semantic: walk, shape: "face1", slot: 0 },
      { semantic: walk, shape: "face1", slot: 1 },
    ]);
  });

  it("skips cells whose geometry doesn't fit the target's shape, unless forced", () => {
    const { p, deck, rail } = factory();
    p.run(cmd("fill", { where: { box: [0, 0, 0, 3, 0, 0] }, state: { semantic: deck } }));
    const skipped = p.run(
      cmd("resemantic", { where: { box: [0, 0, 0, 3, 0, 0] }, from: deck, to: rail }),
    );
    expect(skipped.report.notes).toEqual({ switched: 0, skipped: 4 });
    expect(skipped.report.cells).toBe(0);
    const forced = p.run(
      cmd("resemantic", { where: { box: [0, 0, 0, 3, 0, 0] }, from: deck, to: rail, force: true }),
    );
    expect(forced.report.notes).toEqual({ switched: 4, skipped: 0 });
    expect(p.world.get(0, 0, 0)?.semantic).toBe(rail);
  });
});

describe("shared palettes (linked copies)", () => {
  const theme = (version: number, deckBlock: string) => ({
    key: "user/concrete-theme",
    version,
    name: "Concrete theme",
    semantics: [
      { key: "deck", name: "Deck", look: { block: deckBlock } },
      { key: "wall", name: "Wall", look: { block: "minecraft:gray_concrete" } },
    ],
  });

  it("follow the shared palette across re-syncs, keeping ids and cells", () => {
    const p = new Project({ chunkBits: 4 });
    const synced = p.run(cmd("palette_sync", theme(1, "minecraft:white_concrete")));
    const linked = synced.report.created.palettes[0] ?? 0;
    expect(p.semantics.palette(linked).linked).toEqual({ key: "user/concrete-theme", version: 1 });
    // The project's own palette extends the theme and places its Deck.
    p.run(cmd("palette_update", { palette: ROOT_PALETTE, extends: linked }));
    const deck = p.semantics.byName("Deck", linked) ?? 0;
    p.run(
      cmd("fill", {
        where: { box: [0, 0, 0, 3, 0, 3] },
        state: { semantic: { palette: ROOT_PALETTE, base: deck } },
      }),
    );
    const cells = dump(p.world);
    const mine = p.semantics.byName("Deck", ROOT_PALETTE) ?? 0;

    p.run(cmd("palette_sync", theme(2, "minecraft:light_gray_concrete")));
    expect(p.semantics.byName("Deck", linked)).toBe(deck);
    expect(p.semantics.resolve(mine).look.block).toBe("minecraft:light_gray_concrete");
    expect(dump(p.world)).toEqual(cells);
    // An older version doesn't roll the copy back.
    p.run(cmd("palette_sync", theme(1, "minecraft:white_concrete")));
    expect(p.semantics.resolve(mine).look.block).toBe("minecraft:light_gray_concrete");
  });

  it("are read-only in the project", () => {
    const p = new Project({ chunkBits: 4 });
    const linked =
      p.run(cmd("palette_sync", theme(1, "minecraft:white_concrete"))).report.created.palettes[0] ??
      0;
    const deck = p.semantics.byName("Deck", linked) ?? 0;
    expect(() => p.run(cmd("semantic_update", { semantic: deck, look: { block: "x:y" } }))).toThrow(
      /linked/,
    );
    expect(() => p.run(cmd("semantic_add", { name: "Lamp", palette: linked }))).toThrow(/linked/);
  });
});
