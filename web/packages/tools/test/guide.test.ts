import { describe, expect, it } from "vitest";
import { ok, setup } from "./helpers.ts";

describe("guide", () => {
  it("returns the whole note, or one section", async () => {
    const { host } = setup();
    const all = await ok(host, "guide", {});
    expect(all.text).toContain("North is -Z");
    expect(all.text).toContain("symmetry");
    expect(all.topics).toContain("workflow");
    const axes = await ok(host, "guide", { topic: "axes" });
    expect(axes.topic).toBe("axes");
    expect(axes.text).toContain("+Y is up");
    expect(axes.text).not.toContain("prefab_save");
  });
});
