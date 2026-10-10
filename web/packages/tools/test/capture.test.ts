import { describe, expect, it } from "vitest";
import { call, ok, setup } from "./helpers.ts";

describe("capture", () => {
  it("asks the tab for one picture, and a dry run asks for none", async () => {
    const { host } = setup();
    await ok(host, "place", {
      at: [
        [0, 0, 0],
        [3, 1, 2],
      ],
      semantic: "Wall",
    });
    const dry = await ok(host, "capture", { dry_run: true, from: "north", elevation: "top" });
    expect(dry.dry_run).toBe(true);
    expect(dry.from).toBe(0);
    expect(dry.elevation).toBe(89);
    expect(host.effects).toHaveLength(0);

    const shot = await ok(host, "capture", { from: "se", elevation: "eye", ortho: true });
    expect(shot.from).toBe(135);
    expect(shot.ortho).toBe(true);
    expect(shot.mode).toBe("intent");
    const effect = host.effects.at(-1);
    expect(effect?.kind).toBe("capture");
    if (effect?.kind !== "capture") return;
    expect(effect.shots).toHaveLength(1);
    expect(effect.shots[0]?.box).toEqual({ min: [0, 0, 0], max: [4, 2, 3] });
  });

  it("packs a review sheet and compare tiles", async () => {
    const { host } = setup();
    await ok(host, "place", { at: [[0, 0, 0]], semantic: "Floor" });
    await ok(host, "place", { at: [[8, 0, 8]], semantic: "Wall" });
    const review = await ok(host, "capture_sheet", { preset: "review" });
    expect(review.tiles).toHaveLength(6);
    expect(review.columns).toBe(3);
    const effect = host.effects.at(-1);
    expect(effect?.kind).toBe("capture");
    if (effect?.kind !== "capture") return;
    expect(effect.shots.map((s) => s.label)).toEqual([
      "Hero",
      "Eye level",
      "Front",
      "Side",
      "Top",
      "Back",
    ]);
    expect(effect.shots[2]?.ortho).toBe(true);

    const compared = await ok(host, "capture_sheet", {
      preset: "compare",
      regions: [{ box: [0, 0, 0, 0, 0, 0] }, { semantic: "Wall" }],
      labels: ["Stone", "Brick"],
      from: "west",
    });
    expect(compared.tiles).toEqual([
      expect.objectContaining({ label: "Stone", from: 270 }),
      expect.objectContaining({ label: "Brick", from: 270 }),
    ]);
  });

  it("refuses an empty build and a bad compass word", async () => {
    const { host } = setup();
    expect((await call(host, "capture", {})).error.code).toBe("bad_region");
    await ok(host, "place", { at: [[0, 0, 0]], semantic: "Floor" });
    expect((await call(host, "capture", { from: "sideways" })).error.code).toBe("bad_argument");
    expect((await call(host, "capture_sheet", { preset: "compare" })).error.code).toBe(
      "bad_argument",
    );
  });
});
