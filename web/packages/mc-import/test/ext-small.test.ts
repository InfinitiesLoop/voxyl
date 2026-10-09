import { describe, expect, it } from "vitest";
import { healCatwalks } from "../src/extensions/catwalks.ts";
import { healEtfuturum } from "../src/extensions/etfuturum.ts";
import { healExtraUtils } from "../src/extensions/extrautils.ts";
import { healProjRed } from "../src/extensions/projred.ts";
import { healZtones } from "../src/extensions/ztones.ts";
import { bytesSource, ZipAssetSource } from "../src/index.ts";
import { LibraryDraft } from "../src/legacy/draft.ts";
import { HealContext } from "../src/legacy/heal.ts";
import { TextureIngest } from "../src/legacy/texture.ts";
import { png, solid, zip } from "./helpers.ts";

/** A mod jar of these textures, `path` relative to the jar ("ns/textures/blocks/x") without .png. */
async function jar(textures: Record<string, [number, number, number]>) {
  const files: Record<string, Uint8Array> = {};
  for (const [path, [r, g, b]] of Object.entries(textures)) {
    files[`assets/${path}.png`] = await png(16, 16, solid(r, g, b));
  }
  return await ZipAssetSource.open("test.jar", bytesSource(await zip(files)));
}

/** The single cube element of a block's default model. */
function elementOf(ctx: HealContext, name: string) {
  const model = ctx.draft.block(name)?.variants?.[""]?.model ?? "";
  return ctx.draft.models[model]?.elements[0];
}

async function context(
  source: Awaited<ReturnType<typeof jar>>,
  ns: string,
  draft = new LibraryDraft(ns),
  legacyIdFor?: (registry: string) => number,
) {
  return new HealContext({
    draft,
    source,
    ns,
    ingest: new TextureIngest(),
    ...(legacyIdFor && { legacyIdFor }),
  });
}

describe("EtFuturum concrete", () => {
  it("binds each meta to its colour-prefixed file under minecraft", async () => {
    const source = await jar({
      "minecraft/textures/blocks/white_concrete": [240, 240, 240],
      "minecraft/textures/blocks/light_blue_concrete": [0, 100, 200],
      "minecraft/textures/blocks/black_concrete_powder": [10, 10, 10],
    });
    const ctx = await context(source, "etfuturum");
    await healEtfuturum(ctx);

    const white = ctx.draft.findByIdentity("etfuturum:concrete", 0);
    expect(white?.name).toBe("White Concrete");
    // Meta 3 is vanilla's light blue; the name comes from the colour, spaced and capitalised.
    expect(ctx.draft.findByIdentity("etfuturum:concrete", 3)?.name).toBe("Light Blue Concrete");
    const powder = ctx.draft.findByIdentity("etfuturum:concrete_powder", 15);
    expect(powder?.name).toBe("Black Concrete Powder");
    // Metas without a texture file are skipped, not stubbed.
    expect(ctx.draft.findByIdentity("etfuturum:concrete", 1)).toBeUndefined();
    expect(Object.keys(ctx.draft.blocks)).toHaveLength(3);

    const element = elementOf(ctx, "White Concrete");
    expect(Object.keys(element?.faces ?? {}).sort()).toEqual([
      "down",
      "east",
      "north",
      "south",
      "up",
      "west",
    ]);
    expect(element?.faces.up?.texture).toBe("minecraft:blocks/white_concrete");
    expect(white?.block.mc).toMatchObject({ registry: "etfuturum:concrete", meta: 0 });
  });

  it("refreshes a block already confirmed for the identity instead of minting a copy", async () => {
    const source = await jar({ "minecraft/textures/blocks/red_concrete": [200, 0, 0] });
    const ctx = await context(source, "etfuturum");
    await healEtfuturum(ctx);
    await healEtfuturum(ctx);
    expect(Object.keys(ctx.draft.blocks).filter((n) => n.includes("Red"))).toEqual([
      "Red Concrete",
    ]);
  });

  it("records the install's numeric block id when it knows one", async () => {
    const source = await jar({ "minecraft/textures/blocks/lime_concrete": [0, 200, 0] });
    const ctx = await context(source, "etfuturum", undefined, (r) =>
      r === "etfuturum:concrete" ? 2201 : -1,
    );
    await healEtfuturum(ctx);
    expect(ctx.draft.findByIdentity("etfuturum:concrete", 5)?.block.mc?.legacyId).toBe(2201);
  });
});

describe("Catwalks", () => {
  const paths = [
    "sturdy_rail/normal",
    "sturdy_rail/booster_off",
    "sturdy_rail/detector_off",
    "sturdy_rail/activator_off",
    "support",
    "scaffold_builders_top",
    "scaffold_builders_side",
    "transparent",
    "catwalk/bottom/plain/no_lights",
    "catwalk/side/plain/no_lights",
    "catwalk/bottom/tape/no_lights",
    "catwalk/side/tape/no_lights",
    "ladder/side/plain/no_lights",
    "ladder/bottom/plain/no_lights",
    "ladder/front/plain/no_lights",
    "ladder/ladder/plain/no_lights",
  ];

  it("makes the eight stand-ins with their registry, meta and per-face textures", async () => {
    const source = await jar(
      Object.fromEntries(
        paths.map((p, i) => [`catwalks/textures/blocks/${p}`, [i * 10, 50, 50]] as const),
      ),
    );
    const ctx = await context(source, "catwalks");
    await healCatwalks(ctx);

    expect(Object.keys(ctx.draft.blocks).sort()).toEqual([
      "Builder's Scaffold",
      "Caged Ladder",
      "Catwalk",
      "Catwalk (Tape)",
      "Sturdy Activator Rail",
      "Sturdy Detector Rail",
      "Sturdy Powered Rail",
      "Sturdy Rail",
      "Support Column",
    ]);
    // The scaffold's only placeable state is meta 1, unlike every other entry.
    expect(ctx.draft.findByIdentity("catwalks:scaffold", 1)?.name).toBe("Builder's Scaffold");
    expect(ctx.draft.findByIdentity("catwalks:catwalk_unlit_tape", 0)?.name).toBe("Catwalk (Tape)");

    const faces = elementOf(ctx, "Caged Ladder")?.faces;
    expect(faces?.north?.texture).toBe("catwalks:blocks/ladder/front/plain/no_lights");
    expect(faces?.south?.texture).toBe("catwalks:blocks/ladder/ladder/plain/no_lights");
    expect(faces?.down?.texture).toBe("catwalks:blocks/ladder/bottom/plain/no_lights");
  });

  it("colours a catwalk by its sides, since its top is a transparent texture", async () => {
    const files: Record<string, Uint8Array> = {};
    for (const p of paths) {
      files[`assets/catwalks/textures/blocks/${p}.png`] = await png(16, 16, solid(100, 100, 100));
    }
    files["assets/catwalks/textures/blocks/transparent.png"] = await png(16, 16, solid(0, 0, 0, 0));
    files["assets/catwalks/textures/blocks/catwalk/side/plain/no_lights.png"] = await png(
      16,
      16,
      solid(200, 40, 40),
    );
    const source = await ZipAssetSource.open("test.jar", bytesSource(await zip(files)));
    const ctx = await context(source, "catwalks");
    await healCatwalks(ctx);
    expect(ctx.draft.block("Catwalk")?.color).toBe("#c82828");
    expect(ctx.draft.block("Catwalk")?.transparent).toBe(true);
  });

  it("skips a block, with a warning, when any one face texture is missing", async () => {
    const source = await jar({
      "catwalks/textures/blocks/support": [90, 90, 90],
      "catwalks/textures/blocks/catwalk/side/plain/no_lights": [90, 90, 90],
    });
    const ctx = await context(source, "catwalks");
    await healCatwalks(ctx);
    expect(Object.keys(ctx.draft.blocks)).toEqual(["Support Column"]);
    expect(ctx.warnings.some((w) => w.startsWith("catwalks: missing texture"))).toBe(true);
    expect(ctx.warnings.some((w) => w.endsWith("for Catwalk, skipped"))).toBe(true);
  });
});

describe("ProjectRed Illumination lamp", () => {
  it("reads the on-disk projectred art for both polarities of each colour", async () => {
    const source = await jar({
      "projectred/textures/blocks/lighting/lampoff/0": [200, 200, 200],
      "projectred/textures/blocks/lighting/lampon/0": [255, 255, 255],
      "projectred/textures/blocks/lighting/lampoff/3": [0, 0, 200],
      "projectred/textures/blocks/lighting/lampon/3": [100, 100, 255],
    });
    const ctx = await context(source, "ProjRed|Illumination");
    await healProjRed(ctx);
    const registry = "ProjRed|Illumination:projectred.illumination.lamp";

    expect(Object.keys(ctx.draft.blocks).sort()).toEqual([
      "Inverted Light Blue Lamp",
      "Inverted White Lamp",
      "Light Blue Lamp",
      "White Lamp",
    ]);
    // Normal lamps are metas 0-15 drawn off; inverted are 16-31 drawn on.
    const normal = ctx.draft.findByIdentity(registry, 3);
    expect(normal?.name).toBe("Light Blue Lamp");
    const inverted = ctx.draft.findByIdentity(registry, 19);
    expect(inverted?.name).toBe("Inverted Light Blue Lamp");
    const faceOf = (name: string | undefined) => elementOf(ctx, name ?? "")?.faces.up?.texture;
    expect(faceOf(normal?.name)).toBe("projectred:blocks/lighting/lampoff/3");
    expect(faceOf(inverted?.name)).toBe("projectred:blocks/lighting/lampon/3");
  });
});

describe("Extra Utilities Lapis Caelestis", () => {
  it("synthesises 16 solid colours without reading any source art", async () => {
    const source = await jar({});
    const ctx = await context(source, "ExtraUtilities");
    await healExtraUtils(ctx);

    expect(Object.keys(ctx.draft.blocks)).toHaveLength(16);
    const registry = "ExtraUtilities:greenscreen";
    const white = ctx.draft.findByIdentity(registry, 0);
    expect(white?.name).toBe("Lapis Caelestis Albus (White)");
    expect(white?.block.color).toBe("#ffffff");
    const brown = ctx.draft.findByIdentity(registry, 12);
    expect(brown?.name).toBe("Lapis Caelestis Fuscus (Brown)");
    expect(brown?.block.color).toBe("#2a3300");
    expect(ctx.draft.findByIdentity(registry, 15)?.name).toBe("Lapis Caelestis Nox (Black)");

    const tex = ctx.draft.texture("extrautils:heal/greenscreen_3");
    expect(tex?.color).toBe("#007edd");
    expect(ctx.warnings).toEqual([]);
  });

  it("is idempotent: running again refreshes the same 16 blocks", async () => {
    const ctx = await context(await jar({}), "ExtraUtilities");
    await healExtraUtils(ctx);
    await healExtraUtils(ctx);
    expect(Object.keys(ctx.draft.blocks)).toHaveLength(16);
  });
});

describe("Ztones flat lamps", () => {
  async function ztonesDraft() {
    const source = await jar({ "ztones/textures/blocks/lamp": [250, 240, 200] });
    const ctx = await context(source, "Ztones");
    const key = await ctx.ensureTexture("ztones:blocks/lamp");
    const mk = (name: string, registry: string) => {
      ctx.draft.addCube(
        name,
        { up: key ?? "", down: key ?? "", north: key ?? "" },
        {
          modelKey: `ztones:nei/${name}`,
          mc: { registry, meta: 0 },
          color: "#123456",
        },
      );
    };
    mk("Flat Lamp", "Ztones:lampf");
    mk("Flat Lamp (2)", "Ztones:lampt");
    mk("Other", "Ztones:something");
    return ctx;
  }

  it("redraws the lamps as a 0.1-thick ceiling plate and keeps everything else", async () => {
    const ctx = await ztonesDraft();
    await healZtones(ctx);
    for (const name of ["Flat Lamp", "Flat Lamp (2)"]) {
      const block = ctx.draft.block(name);
      const element = elementOf(ctx, name);
      expect(element?.from).toEqual([0, 14.4, 0]);
      expect(element?.to).toEqual([16, 16, 16]);
      // Every side shows the lamp's own texture, not just the three the roster import gave.
      expect(Object.keys(element?.faces ?? {})).toHaveLength(6);
      // Name, colour and Minecraft identity stay: only the default look changes.
      expect(block?.color).toBe("#123456");
      expect(block?.mc?.registry).toMatch(/^Ztones:lamp[ft]$/);
    }
    expect(elementOf(ctx, "Other")?.to).toEqual([16, 16, 16]);
    // lampb was never in the roster, so there is nothing to redraw and nothing is invented.
    expect(ctx.draft.findByIdentity("Ztones:lampb", 0)).toBeUndefined();
  });
});
