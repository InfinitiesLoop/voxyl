import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { boxOf, CellSet } from "../src/index.ts";

const coord = fc.integer({ min: -20, max: 20 });
const pos = fc.tuple(coord, coord, coord);
const box = fc.tuple(coord, coord, coord, coord, coord, coord);
const FACES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const parse = (k: string) => k.split(",").map(Number) as [number, number, number];

function model(set: CellSet): Set<string> {
  const out = new Set<string>();
  set.forEach((x, y, z) => {
    out.add(key(x, y, z));
  });
  return out;
}

function boxCells(b: readonly [number, number, number, number, number, number]): string[] {
  const { x0, y0, z0, x1, y1, z1 } = boxOf(b);
  const out: string[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push(key(x, y, z));
  return out;
}

/** A set built from random adds, deletes and boxes, alongside a plain Set model. */
const built = fc
  .array(fc.oneof(fc.record({ add: pos }), fc.record({ del: pos }), fc.record({ box })), {
    maxLength: 30,
  })
  .map((ops) => {
    const set = new CellSet();
    const m = new Set<string>();
    for (const op of ops) {
      if ("add" in op) {
        set.add(...op.add);
        m.add(key(...op.add));
      } else if ("del" in op) {
        set.delete(...op.del);
        m.delete(key(...op.del));
      } else {
        set.addBox(boxOf(op.box));
        for (const k of boxCells(op.box)) m.add(k);
      }
    }
    return { set, m };
  });

describe("CellSet", () => {
  it("matches a plain set under adds, deletes and boxes, size included", () => {
    fc.assert(
      fc.property(built, pos, ({ set, m }, probe) => {
        expect(model(set)).toEqual(m);
        expect(set.size).toBe(m.size);
        expect(set.has(...probe)).toBe(m.has(key(...probe)));
      }),
    );
  });

  it("does union, intersection and difference like sets", () => {
    fc.assert(
      fc.property(built, built, (a, b) => {
        const union = new Set([...a.m, ...b.m]);
        const inter = new Set([...a.m].filter((k) => b.m.has(k)));
        const diff = new Set([...a.m].filter((k) => !b.m.has(k)));
        const u = a.set.clone().addAll(b.set);
        const i = a.set.clone().retainAll(b.set);
        const d = a.set.clone().removeAll(b.set);
        expect([model(u), model(i), model(d)]).toEqual([union, inter, diff]);
        expect([u.size, i.size, d.size]).toEqual([union.size, inter.size, diff.size]);
        expect(model(a.set)).toEqual(a.m); // the operands are untouched
      }),
      { numRuns: 60 },
    );
  });

  it("grows and shrinks through faces", () => {
    fc.assert(
      fc.property(built, ({ set, m }) => {
        const grown = new Set(m);
        for (const k of m) {
          const [x, y, z] = parse(k);
          for (const [dx, dy, dz] of FACES) grown.add(key(x + dx, y + dy, z + dz));
        }
        expect(model(set.grown(1))).toEqual(grown);
        const withCorners = new Set(m);
        for (const k of m) {
          const [x, y, z] = parse(k);
          for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++)
                if (dx !== 0 || dy !== 0 || dz !== 0) withCorners.add(key(x + dx, y + dy, z + dz));
        }
        expect(model(set.grown(1, true))).toEqual(withCorners);
        const shrunk = [...m].filter((k) => {
          const [x, y, z] = parse(k);
          return FACES.every(([dx, dy, dz]) => m.has(key(x + dx, y + dy, z + dz)));
        });
        expect(model(set.shrunk(1))).toEqual(new Set(shrunk));
      }),
      { numRuns: 40 },
    );
  });

  it("grows a box through corners into a bigger box, and through faces into a cross", () => {
    const box = CellSet.ofBox({ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 });
    const corners = box.grown(1, true);
    expect(corners.size).toBe(4 * 4 * 4);
    expect(corners.bounds()).toEqual({ x0: -1, y0: -1, z0: -1, x1: 2, y1: 2, z1: 2 });
    expect(corners.has(-1, -1, -1)).toBe(true);
    const faces = box.grown(1);
    expect(faces.has(0, -1, 0)).toBe(true);
    expect(faces.has(-1, -1, -1)).toBe(false);
    expect(faces.size).toBeLessThan(corners.size);
  });

  it("keeps a big box as full bricks and reports exact bounds", () => {
    const set = CellSet.ofBox({ x0: -100, y0: 0, z0: -100, x1: 99, y1: 49, z1: 99 });
    expect(set.size).toBe(200 * 50 * 200);
    expect(set.bounds()).toEqual({ x0: -100, y0: 0, z0: -100, x1: 99, y1: 49, z1: 99 });
    expect([...set.bricks()].filter((b) => b.full).length).toBe(24 * 6 * 24); // -100 and 99 cut bricks; y 48-49 does too
    set.delete(0, 0, 0);
    expect(set.size).toBe(200 * 50 * 200 - 1);
    expect(set.has(0, 0, 0)).toBe(false);
    expect(set.has(1, 0, 0)).toBe(true);
  });
});
