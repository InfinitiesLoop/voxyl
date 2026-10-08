import { describe, expect, it } from "vitest";
import { PREVIEW_PITCH_LIMIT, previewTransform, turnByDrag } from "./turntable.ts";

describe("turntable", () => {
  it("turns with a sideways drag and tips with a vertical one", () => {
    expect(turnByDrag({ yaw: 10, pitch: -24 }, 10, 0)).toEqual({ yaw: 14.5, pitch: -24 });
    expect(turnByDrag({ yaw: 0, pitch: 0 }, 0, 10).pitch).toBeCloseTo(-4.5);
  });

  it("stops the tilt short of flipping over", () => {
    expect(turnByDrag({ yaw: 0, pitch: 70 }, 0, -100).pitch).toBe(PREVIEW_PITCH_LIMIT);
    expect(turnByDrag({ yaw: 0, pitch: -70 }, 0, 100).pitch).toBe(-PREVIEW_PITCH_LIMIT);
  });

  it("writes the tilt before the turn", () => {
    expect(previewTransform({ yaw: 30, pitch: -24 })).toBe("rotateX(-24deg) rotateY(30deg)");
  });
});
