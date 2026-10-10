import { probeSchematic } from "@voxyl/schematic";
import { describe, expect, it } from "vitest";
import { call, ok, setup } from "./helpers.ts";

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[n & 63] : "=";
  }
  return out;
}

describe("schematic tools", () => {
  it("reports a dry run, then downloads a file the probe can read", async () => {
    const { host } = setup();
    await ok(host, "place", {
      at: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      semantic: "Wall",
    });
    await ok(host, "place", { at: [[2, 0, 0]], semantic: "Glass" });
    const dry = await ok(host, "export_schematic", { dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.cells_written).toBe(2);
    expect(dry.undecided).toMatchObject({ Glass: 1 });
    expect(host.effects).toHaveLength(0);

    const real = await ok(host, "export_schematic", {});
    expect(real.filename).toBe("Untitled.schematic");
    const effect = host.effects.at(-1);
    expect(effect?.kind).toBe("download");
    if (effect?.kind !== "download") return;
    expect(effect.filename).toBe("Untitled.schematic");
    const probed = await probeSchematic(effect.bytes);
    expect(probed?.histogram["minecraft:brick_block"]).toBe(2);

    const viaTool = await ok(host, "probe_schematic", { bytes: base64(effect.bytes) });
    expect(viaTool.blocks).toBe(2);
    expect(viaTool.histogram["minecraft:brick_block"]).toBe(2);
  });

  it("exports a prefab without an open project", async () => {
    const { host } = setup();
    await ok(host, "place", { at: [[0, 0, 0]], semantic: "Floor" });
    await ok(host, "prefab_save", { name: "Slab", where: { box: [0, 0, 0, 0, 0, 0] } });
    host.project = null;
    const saved = await ok(host, "export_schematic", { prefab: "Slab" });
    expect(saved.filename).toBe("Slab.schematic");
    expect(saved.cells_written).toBe(1);
    expect(host.effects.at(-1)?.kind).toBe("download");
  });

  it("refuses an empty build and a file that is not a schematic", async () => {
    const { host } = setup();
    const empty = await call(host, "export_schematic", {});
    expect(empty.ok).toBe(false);
    expect(empty.error.code).toBe("bad_region");
    const bad = await call(host, "probe_schematic", {
      bytes: base64(new Uint8Array([1, 2, 3, 4])),
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("bad_file");
  });
});
