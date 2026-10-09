import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MultiSource, openArchive, scanInstance } from "../../packages/mc-import/src/index.ts";
import { nodeDir } from "./node-fs.ts";

// The user's own GTNH install; the test is skipped on machines that don't have it.
const INSTANCE =
  process.env.GTNH_INSTANCE ?? `${process.env.APPDATA}/PrismLauncher/instances/GTNH 2.9 RC2`;

describe.skipIf(!existsSync(INSTANCE))("a real GTNH instance", () => {
  it("scans the folders and opens mods without reading them whole", async () => {
    const scan = await scanInstance(nodeDir(INSTANCE));
    expect(scan).not.toBeNull();
    if (!scan) return;
    expect(scan.mods.length).toBeGreaterThan(200);
    expect(scan.config).not.toBeNull();
    const gt = scan.mods.find((m) => /^gregtech-/i.test(m.name));
    expect(gt).toBeDefined();
    if (!gt) return;
    const source = await openArchive(gt);
    expect(source.namespaces()).toContain("gregtech");
    const multi = new MultiSource([source]);
    expect(multi.listFilesRecursive("gregtech/textures/blocks").length).toBeGreaterThan(100);
  }, 60_000);
});
