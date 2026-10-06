import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Command,
  decodeStorageChunk,
  encodeStorageChunk,
  loadProject,
  Project,
  packBundle,
  ROOT_PALETTE,
  STORAGE_SIZE,
  saveProject,
  unpackBundle,
} from "../src/index.ts";

let n = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `f${n++}`, kind, args });

/** Every cell by position, with semantics by name, so ids may differ between projects. */
function describeCells(p: Project): string[] {
  const out: string[] = [];
  p.world.forEachCell((x, y, z, id) => {
    const s = p.world.states.get(id);
    if (!s) return;
    const name = (sem: number) => p.semantics.nameOf(sem);
    const parts = s.parts.map((q) => `${name(q.semantic)}/${q.shape}/${q.slot}`).join("+");
    out.push(`${x},${y},${z}:${name(s.semantic)}:${s.rotation}:${JSON.stringify(s.tags)}:${parts}`);
  });
  return out.sort();
}

/** A small build that touches every part of the format. */
function build(chunkBits = 4) {
  const p = new Project({ chunkBits });
  const walkway =
    p.run(cmd("palette_add", { name: "Walkway", extends: ROOT_PALETTE })).report.created
      .palettes[0] ?? 0;
  const deck =
    p.run(cmd("semantic_add", { name: "Deck", look: { block: "ztones:zane" } })).report.created
      .semantics[0] ?? 0;
  const rail =
    p.run(cmd("semantic_add", { name: "Rail", form: { shape: "edge1" } })).report.created
      .semantics[0] ?? 0;
  p.run(cmd("fill", { where: { box: [-40, 0, -40, 40, 0, 40] }, state: { semantic: deck } }));
  p.run(
    cmd("fill", {
      where: { box: [-5, 1, -5, 5, 1, 5] },
      state: { semantic: { palette: walkway, base: deck }, rotation: 7 },
    }),
  );
  p.run(
    cmd("set", {
      states: [
        { semantic: deck, tags: { note: "hello", power: 3 } },
        {
          parts: [
            { semantic: rail, shape: "edge1", slot: 4 },
            { semantic: deck, shape: "face1", slot: 0 },
          ],
        },
      ],
      cells: [33, 2, 33, 0, -33, 2, 33, 1, 100, 70, -100, 1],
    }),
  );
  return p;
}

describe("storage chunk codec", () => {
  it("round-trips any contents, from empty to more than 256 states", () => {
    const dense = fc.oneof(
      fc.array(fc.integer({ min: 0, max: 3 }), {
        minLength: STORAGE_SIZE ** 3,
        maxLength: STORAGE_SIZE ** 3,
      }),
      fc.array(fc.integer({ min: 0, max: 600 }), {
        minLength: STORAGE_SIZE ** 3,
        maxLength: STORAGE_SIZE ** 3,
      }),
      fc.integer({ min: 0, max: 9 }).map((v) => new Array<number>(STORAGE_SIZE ** 3).fill(v)),
    );
    fc.assert(
      fc.property(dense, (values) => {
        const input = Uint16Array.from(values);
        const encoded = encodeStorageChunk(input);
        if (input.every((v) => v === 0)) {
          expect(encoded).toBeNull();
          return;
        }
        expect(decodeStorageChunk(encoded as Uint8Array, new Uint16Array(input.length))).toEqual(
          input,
        );
      }),
      { numRuns: 20 },
    );
  });
});

describe("saving and loading", () => {
  it.each([3, 4, 5, 6, 7])(
    "round-trips cells, registry and counts (loaded with %i-bit chunks)",
    async (bits) => {
      const p = build(4);
      const saved = await saveProject(p, "Test build");
      const loaded = await loadProject(saved, { chunkBits: bits });
      expect(describeCells(loaded)).toEqual(describeCells(p));
      expect(loaded.world.cellCount).toBe(p.world.cellCount);
      expect(loaded.semantics.toJSON()).toEqual(p.semantics.toJSON());
      expect(saved.manifest.name).toBe("Test build");
    },
  );

  it("saves the same build to the same bytes, whatever its history or chunk size", async () => {
    const a = build(4);
    const b = build(6);
    // b gets there the long way: cells added, then removed again.
    b.run(cmd("fill", { where: { box: [200, 0, 200, 260, 10, 260] }, state: { semantic: 1 } }));
    b.run(cmd("clear", { where: { box: [200, 0, 200, 260, 10, 260] } }));
    const [sa, sb] = [await saveProject(a), await saveProject(b)];
    expect(sb.manifest).toEqual(sa.manifest);
    expect([...sb.blobs.keys()].sort()).toEqual([...sa.blobs.keys()].sort());
  });

  it("stores identical chunks once", async () => {
    const p = new Project({ chunkBits: 5 });
    const s = p.semantics.add("Floor");
    // Sixteen storage chunks, each a full 32³ floor slab pattern at the same local place.
    for (let i = 0; i < 16; i++) {
      p.run(
        cmd("fill", { where: { box: [i * 32, 0, 0, i * 32 + 31, 3, 31] }, state: { semantic: s } }),
      );
    }
    const saved = await saveProject(p);
    expect(Object.keys(saved.manifest.chunks)).toHaveLength(16);
    expect(saved.blobs.size).toBe(1);
  });

  it("packs into one bundle and back", async () => {
    const p = build();
    const bytes = await packBundle(await saveProject(p, "Bundle"));
    const loaded = await loadProject(await unpackBundle(bytes));
    expect(describeCells(loaded)).toEqual(describeCells(p));
    await expect(unpackBundle(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/Voxyl/);
  });
});
