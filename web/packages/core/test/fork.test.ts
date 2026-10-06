import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { World } from "../src/index.ts";

const coord = fc.integer({ min: -30, max: 30 });
const write = fc.record({ x: coord, y: coord, z: coord, s: fc.integer({ min: 0, max: 300 }) });

function dump(world: World): Map<string, number> {
  const cells = new Map<string, number>();
  world.forEachCell((x, y, z, id) => cells.set(`${x},${y},${z}`, id));
  return cells;
}

/** Writes through a state per distinct number (0 clears), so palettes overflow to 16-bit. */
function apply(world: World, w: { x: number; y: number; z: number; s: number }): void {
  world.setId(w.x, w.y, w.z, w.s === 0 ? 0 : world.states.intern({ semantic: w.s }));
}

describe("World.fork (copy-on-write chunks)", () => {
  it.each([3, 4, 5])("keeps a fork and its parent independent (%i-bit chunks)", (chunkBits) => {
    fc.assert(
      fc.property(
        fc.array(write, { maxLength: 400 }),
        fc.array(write, { maxLength: 300 }),
        fc.array(write, { maxLength: 300 }),
        (base, forParent, forFork) => {
          const parent = new World({ chunkBits });
          for (const w of base) apply(parent, w);
          const fork = parent.fork();
          // Reference worlds built without forking.
          const parentModel = new World({ chunkBits, states: parent.states });
          const forkModel = new World({ chunkBits, states: parent.states });
          for (const w of base) {
            apply(parentModel, w);
            apply(forkModel, w);
          }
          for (const w of forParent) {
            apply(parent, w);
            apply(parentModel, w);
          }
          for (const w of forFork) {
            apply(fork, w);
            apply(forkModel, w);
          }
          expect(dump(parent)).toEqual(dump(parentModel));
          expect(dump(fork)).toEqual(dump(forkModel));
          expect(parent.cellCount).toBe(parentModel.cellCount);
          expect(fork.cellCount).toBe(forkModel.cellCount);
        },
      ),
      { numRuns: 80 },
    );
  });
});
