import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Chunk, ChunkLayout, EMPTY_ID } from "../src/index.ts";

function firstMismatch(a: Uint16Array, b: Uint16Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : a.length;
}

describe.each([3, 5])("Chunk with %i-bit layout", (bits) => {
  const L = new ChunkLayout(bits);
  const local = fc.integer({ min: 0, max: L.size - 1 });

  it("matches a dense array under random sets and fills, across palette overflow", () => {
    // Up to 400 distinct ids, so some runs overflow the 255-slot palette and go 16-bit.
    const id = fc.oneof(
      fc.constant(EMPTY_ID),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 1, max: 400 }),
    );
    const set = fc.record({ kind: fc.constant("set" as const), x: local, y: local, z: local, id });
    const fill = fc.record({
      kind: fc.constant("fill" as const),
      a: fc.tuple(local, local, local),
      b: fc.tuple(local, local, local),
      id,
    });
    fc.assert(
      fc.property(
        fc.array(fc.oneof({ weight: 4, arbitrary: set }, { weight: 1, arbitrary: fill }), {
          maxLength: 400,
        }),
        (edits) => {
          const chunk = new Chunk(L);
          const model = new Uint16Array(L.volume);
          for (const edit of edits) {
            if (edit.kind === "set") {
              const index = L.localIndex(edit.x, edit.y, edit.z);
              expect(chunk.set(index, edit.id)).toBe(model[index]);
              model[index] = edit.id;
            } else {
              const [x0, x1] = [Math.min(edit.a[0], edit.b[0]), Math.max(edit.a[0], edit.b[0])];
              const [y0, y1] = [Math.min(edit.a[1], edit.b[1]), Math.max(edit.a[1], edit.b[1])];
              const [z0, z1] = [Math.min(edit.a[2], edit.b[2]), Math.max(edit.a[2], edit.b[2])];
              let expected = 0;
              for (let y = y0; y <= y1; y++)
                for (let z = z0; z <= z1; z++)
                  for (let x = x0; x <= x1; x++) {
                    const index = L.localIndex(x, y, z);
                    if (model[index] !== edit.id) expected++;
                    model[index] = edit.id;
                  }
              expect(chunk.fill(x0, x1, y0, y1, z0, z1, edit.id)).toBe(expected);
            }
          }
          // Plain loops: deep-equality on 32k-element arrays is far slower than the chunk.
          expect(firstMismatch(chunk.toArray(), model)).toBe(-1);
          expect(chunk.count).toBe(model.reduce((n, v) => n + (v === EMPTY_ID ? 0 : 1), 0));
          for (let i = 0; i < L.volume; i += 7) {
            if (chunk.get(i) !== model[i]) expect(chunk.get(i)).toBe(model[i]);
          }
          const visited = new Uint16Array(L.volume);
          chunk.forEachOccupied((index, cellId) => {
            visited[index] = cellId;
          });
          expect(firstMismatch(visited, model)).toBe(-1);
        },
      ),
      { numRuns: 40 },
    );
  }, 30_000);
});

describe("Chunk memory", () => {
  const L = new ChunkLayout(6);
  const dense = L.volume * 2;

  it("holds no cell arrays when empty or when fills cover whole bricks", () => {
    const chunk = new Chunk(L);
    const empty = chunk.memoryBytes;
    expect(empty).toBeLessThan(dense / 100);
    chunk.fill(0, 63, 0, 31, 0, 63, 5);
    expect(chunk.count).toBe(64 * 32 * 64);
    expect(chunk.memoryBytes).toBe(empty);
  });

  it("uses one byte per cell in mixed bricks and frees them when cleared", () => {
    const chunk = new Chunk(L);
    const empty = chunk.memoryBytes;
    chunk.set(L.localIndex(1, 1, 1), 7);
    chunk.set(L.localIndex(2, 1, 1), 9);
    expect(chunk.memoryBytes - empty).toBeLessThanOrEqual(L.brickVolume + 64);
    chunk.set(L.localIndex(1, 1, 1), EMPTY_ID);
    chunk.set(L.localIndex(2, 1, 1), EMPTY_ID);
    expect(chunk.count).toBe(0);
    expect(chunk.memoryBytes).toBeLessThanOrEqual(empty + 64);
  });
});
