import { World } from "@voxyl/core";
import { describe, expect, it } from "vitest";
import { chunkEdges, EDGE_WORDS, edgeAt, paddedVolume } from "../src/index.ts";

const BITS = 3;

function edgesOf(build: (world: World) => void) {
  const world = new World({ chunkBits: BITS });
  build(world);
  const cells = world.copyPadded(0, 0, 0, new Uint16Array(paddedVolume(BITS)));
  const { edges, edgeCount } = chunkEdges(BITS, cells);
  return Array.from({ length: edgeCount }, (_, e) => {
    const w = (i: number) => edges[e * EDGE_WORDS + i] ?? 0;
    return { at: [w(0), w(1), w(2)], axis: w(3), length: w(4), id: w(5) };
  });
}

describe("feature edges", () => {
  it("draws a lone cube's twelve edges", () => {
    const edges = edgesOf((w) => w.set(1, 1, 1, { semantic: 1 }));
    expect(edges).toHaveLength(12);
    expect(edges.every((e) => e.length === 1)).toBe(true);
  });

  it("merges a row into long edges and leaves its flat faces bare", () => {
    const edges = edgesOf((w) => {
      for (let x = 0; x < 5; x++) w.set(x, 0, 0, { semantic: 1 });
    });
    // Four long edges along x, and four short ones across each end.
    expect(edges.filter((e) => e.axis === 0).map((e) => e.length)).toEqual([5, 5, 5, 5]);
    expect(edges.filter((e) => e.axis !== 0)).toHaveLength(8);
  });

  it("marks a seam where two states meet on a flat face", () => {
    const one = edgesOf((w) => {
      w.set(0, 0, 0, { semantic: 1 });
      w.set(1, 0, 0, { semantic: 1 });
    });
    const two = edgesOf((w) => {
      w.set(0, 0, 0, { semantic: 1 });
      w.set(1, 0, 0, { semantic: 2 });
    });
    // Four seam edges, and each long edge splits in two where the state changes.
    expect(two.length - one.length).toBe(8);
  });

  it("tells corners, creases and flat faces apart", () => {
    expect(edgeAt(1, 0, 0, 0)).toBe(1);
    expect(edgeAt(1, 1, 1, 0)).toBe(1);
    expect(edgeAt(1, 0, 0, 1)).toBe(1);
    expect(edgeAt(1, 1, 0, 0)).toBe(0);
    expect(edgeAt(1, 2, 0, 0)).toBe(1);
    expect(edgeAt(1, 1, 1, 1)).toBe(0);
    expect(edgeAt(0, 0, 0, 0)).toBe(0);
  });
});
