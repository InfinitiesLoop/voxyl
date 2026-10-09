import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importInstance, planInstance } from "../../packages/mc-import/src/index.ts";
import { nodeDir, nodeFileAt } from "./node-fs.ts";

// The user's own GTNH install with NEI dumps; skipped where it isn't.
const GAME = `${process.env.APPDATA}/PrismLauncher/instances/GTNH 2.9 Beta 2/.minecraft`;
const VANILLA = `${process.env.APPDATA}/PrismLauncher/libraries/com/mojang/minecraft/1.7.10/minecraft-1.7.10-client.jar`;

describe.skipIf(!existsSync(GAME) || !existsSync(VANILLA))("importing a real instance", () => {
  it("plans, then imports every mod as a library", async () => {
    const plan = await planInstance(nodeDir(GAME));
    expect(plan?.problems).toEqual([]);
    const phases = new Set<string>();
    const result = await importInstance({
      picked: nodeDir(GAME),
      vanillaJar: nodeFileAt(VANILLA),
      onProgress: (phase) => phases.add(phase),
    });
    expect(result.libraries.length).toBeGreaterThan(50);
    expect(result.imported).toBeGreaterThan(1000);
    expect(phases.has("Healing mods")).toBe(true);
    const ztones = result.libraries.find((l) => l.id === "pack-Ztones");
    expect(Object.keys(ztones?.blocks ?? {}).length).toBe(551);
    console.log(
      `${result.libraries.length} libraries, ${result.imported} blocks, ${result.dropped} left out, ` +
        `${result.healed.length} healed, ${Math.round(result.ms)} ms`,
    );
  }, 120_000);

  it("explains a folder without NEI dumps", async () => {
    const rc2 = `${process.env.APPDATA}/PrismLauncher/instances/GTNH 2.9 RC2`;
    if (!existsSync(rc2)) return;
    const plan = await planInstance(nodeDir(rc2));
    expect(plan?.problems.join(" ")).toMatch(/Data Dumps/);
  });
});
