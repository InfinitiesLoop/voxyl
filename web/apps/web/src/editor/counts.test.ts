import { describe, expect, it } from "vitest";
import { countText, grouped, nudgedBox, stacks } from "./counts.ts";
import { orbitOffset } from "./orbit.ts";

describe("counts", () => {
  it("groups thousands and writes full stacks", () => {
    expect(grouped(500)).toBe("500");
    expect(grouped(1_234_567)).toBe("1,234,567");
    expect(grouped(-1200)).toBe("-1,200");
    expect(stacks(63)).toBe("");
    expect(stacks(64)).toBe("1×64");
    expect(stacks(500)).toBe("7×64 + 52");
    expect(countText(500)).toBe("500 = 7×64 + 52");
    expect(countText(10)).toBe("10");
  });

  it("nudges a face and stops it at the opposite one", () => {
    expect(nudgedBox([0, 0, 0, 2, 1, 1], 0, true, 3)).toEqual([0, 0, 0, 5, 1, 1]);
    // Inward: the low face stops when it meets the high one.
    expect(nudgedBox([0, 0, 0, 2, 1, 1], 1, false, 5)).toEqual([0, 1, 0, 2, 1, 1]);
  });
});

describe("orbit", () => {
  it("swings a camera on +Z toward +X and raises it", () => {
    const turned = orbitOffset([0, 0, 10], Math.PI / 2, 0, 0);
    expect(turned[0]).toBeCloseTo(10);
    expect(turned[1]).toBeCloseTo(0);
    expect(turned[2]).toBeCloseTo(0);
    const raised = orbitOffset([0, 0, 10], 0, 0.4, 0);
    expect(raised[1]).toBeGreaterThan(0);
    expect(Math.hypot(raised[0], raised[2])).toBeLessThan(10);
  });

  it("stops short of looking straight up", () => {
    const raised = orbitOffset([0, 0, 10], 0, 10, 0);
    expect(raised[1]).toBeLessThan(10);
    expect(raised[1]).toBeGreaterThan(9);
  });
});
