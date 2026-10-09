import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importGtnh } from "./gtnh-roster.ts";

// The user's own GTNH install and its 1.7.10 client jar; skipped on machines without them.
const APPDATA = process.env.APPDATA ?? "";
const INSTANCE = process.env.GTNH_INSTANCE ?? `${APPDATA}/PrismLauncher/instances/GTNH 2.9 Beta 2`;
const VANILLA =
  process.env.GTNH_VANILLA_JAR ??
  `${APPDATA}/PrismLauncher/libraries/com/mojang/minecraft/1.7.10/minecraft-1.7.10-client.jar`;

describe.skipIf(!existsSync(INSTANCE) || !existsSync(VANILLA))("a real GTNH roster import", () => {
  it("imports thousands of confirmed blocks from every jar, in reasonable time", async () => {
    const run = await importGtnh(`${INSTANCE}/.minecraft`, VANILLA);
    const { result, roster } = run;

    const perMod = roster.mods.map((mod) => {
      const imported = result.imported.filter((e) => e.mod === mod).length;
      return `${mod.padEnd(32)} ${String(imported).padStart(5)} imported ${String(
        result.droppedByMod[mod] ?? 0,
      ).padStart(6)} dropped`;
    });
    console.log(perMod.join("\n"));
    console.log(
      `${result.imported.length} imported, ${result.dropped.length} dropped, ` +
        `${roster.allEntries().length} roster rows in ${roster.mods.length} mods; ` +
        `${run.jars} jars opened in ${Math.round(run.openMs)} ms, imported in ` +
        `${Math.round(run.importMs)} ms, rss ${run.rssMb} MB; ${result.warnings.length} warnings`,
    );

    expect(result.imported.length).toBeGreaterThan(1000);
    expect(result.dropped.length).toBeGreaterThan(1000);
    // Every row is either imported or dropped; an identity is never both.
    const identity = (e: { registry: string; meta: number }) => `${e.registry}@${e.meta}`;
    const rows = new Set(roster.allEntries().map(identity));
    const settled = new Set([...result.imported, ...result.dropped].map(identity));
    expect(settled.size).toBe(rows.size);
    expect(result.imported.length + result.dropped.length).toBe(roster.allEntries().length);
    const droppedIds = new Set(result.dropped.map(identity));
    expect(result.imported.every((e) => !droppedIds.has(identity(e)))).toBe(true);
    // Vanilla's own blocks bind from the 1.7.10 client jar.
    const stone = result.imported.find((e) => e.registry === "minecraft:stone" && e.meta === 0);
    expect(stone?.name).toBe("Stone");
    const faces = run.drafts.get("minecraft")?.block("Stone")?.variants?.[""]?.model ?? "";
    expect(run.drafts.get("minecraft")?.models[faces]?.elements[0]?.faces.up?.texture).toBe(
      "minecraft:blocks/stone",
    );
    // Every imported block is a cube of textures the draft holds.
    for (const draft of run.drafts.values()) {
      for (const block of Object.values(draft.blocks)) {
        const model = draft.models[block.variants?.[""]?.model ?? ""];
        for (const face of Object.values(model?.elements[0]?.faces ?? {}))
          expect(draft.hasTexture(face.texture)).toBe(true);
      }
    }
    expect(run.importMs).toBeLessThan(60_000);
  }, 180_000);
});
