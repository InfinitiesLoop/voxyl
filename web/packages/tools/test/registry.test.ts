import { describe, expect, it } from "vitest";
import { callTool, listTools, MemoryHost, TOOLS } from "../src/index.ts";
import { call, ok, setup } from "./helpers.ts";

describe("registry", () => {
  it("lists every tool with a JSON Schema, annotations and a short description", () => {
    const listing = listTools();
    expect(listing.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(listing.map((t) => t.name)).toEqual([
      "status",
      "history",
      "inspect",
      "select",
      "place",
      "fill",
      "clear",
      "replace",
    ]);
    for (const t of listing) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description.length).toBeLessThan(700);
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
    }
    // The recursive region language survives the conversion.
    expect(JSON.stringify(listing.find((t) => t.name === "fill")?.inputSchema)).toContain("box");
    for (const t of listing.filter(
      (t) => t.annotations.readOnlyHint === false && t.name !== "select",
    )) {
      expect(Object.keys(t.inputSchema.properties as object)).toContain("dry_run");
      expect(Object.keys(t.inputSchema.properties as object)).toContain("op_id");
    }
  });

  it("answers an unknown tool with near matches, and never throws", async () => {
    const { host } = setup();
    const r = await call(host, "fil", {});
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("unknown_tool");
    expect(r.error.suggestions).toContain("fill");
    expect(await callTool(host, "status", "not an object")).toMatchObject({ ok: false });
  });

  it("reports bad arguments with the path and a message", async () => {
    const { host } = setup();
    const missing = await call(host, "fill", { semantic: "Floor" });
    expect(missing.error.code).toBe("bad_argument");
    expect(missing.error.message).toContain("where");

    const wrongType = await call(host, "fill", {
      where: { box: [0, 0, 0, 1, 1, "x"] },
      semantic: "Floor",
    });
    expect(wrongType.error.code).toBe("bad_argument");
    expect(wrongType.error.issues.length).toBeGreaterThan(0);

    const extra = await call(host, "history", { action: "list", bogus: 1 });
    expect(extra.error.code).toBe("bad_argument");

    const badEnum = await call(host, "inspect", { view: "everything" });
    expect(badEnum.error.code).toBe("bad_argument");

    const badBox = await call(host, "clear", { where: { boxx: [0, 0, 0, 1, 1, 1] } });
    expect(badBox.error.code).toBe("bad_argument");
    expect(badBox.error.message).toMatch(/where/);
  });

  it("needs a project for everything but status", async () => {
    const host = new MemoryHost(null);
    const r = await call(host, "inspect", {});
    expect(r.error.code).toBe("no_project");
    const s = await ok(host, "status");
    expect(s.project).toBeNull();
  });

  it("turns core failures into command_failed, not throws", async () => {
    const { host } = setup();
    const r = await call(host, "clear", { where: { not: { box: [0, 0, 0, 1, 1, 1] } } });
    expect(r.ok).toBe(false);
    expect(["command_failed", "bad_region"]).toContain(r.error.code);
  });
});
