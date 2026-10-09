import { textureOf } from "@voxyl/blocks";
import { describe, expect, it } from "vitest";
import { healGregtech } from "../src/extensions/gregtech.ts";
import { bytesSource, ZipAssetSource } from "../src/index.ts";
import { LibraryDraft } from "../src/legacy/draft.ts";
import { HealContext } from "../src/legacy/heal.ts";
import { TextureIngest } from "../src/legacy/texture.ts";
import { png, solid, zip } from "./helpers.ts";

const ICONS = "gregtech/textures/blocks/iconsets";
const MACHINES = "gregtech/textures/blocks/basicmachines";
const HULL = "gregtech:blocks/iconsets";

/** An opaque 16x16 tile of one colour. */
const tile = (r: number, g: number, b: number) => png(16, 16, solid(r, g, b));

/** A transparent overlay with one opaque white pixel at the top-left corner. */
const overlay = () => {
  const rgba = solid(0, 0, 0, 0);
  rgba.set([255, 255, 255, 255], 0);
  return png(16, 16, rgba);
};

async function heal(
  files: Record<string, Uint8Array | string>,
  lang = "",
  seed?: (draft: LibraryDraft) => void,
) {
  const prefixed = Object.fromEntries(Object.entries(files).map(([k, v]) => [`assets/${k}`, v]));
  const source = await ZipAssetSource.open("gregtech.jar", bytesSource(await zip(prefixed)));
  const draft = new LibraryDraft("gregtech");
  seed?.(draft);
  const ingest = new TextureIngest();
  const ctx = new HealContext({
    draft,
    source,
    ns: "gregtech",
    ingest,
    siblingText: async (name) => (name === "GregTech.lang" ? lang : ""),
  });
  await healGregtech(ctx);
  return { draft, warnings: ctx.warnings };
}

/** The texture key a block draws on one side. */
function faceOf(draft: LibraryDraft, name: string, side: "north" | "east" | "up" | "down") {
  const model = Object.values(draft.block(name)?.variants ?? {})[0]?.model ?? "";
  return draft.models[model]?.elements[0]?.faces[side]?.texture;
}

/** A pixel of a library texture as [r, g, b, a]. */
function pixel(draft: LibraryDraft, key: string, index: number) {
  return [...(draft.texture(key)?.rgba.subarray(index * 4, index * 4 + 4) ?? [])];
}

const HULLS = {
  [`${ICONS}/MACHINE_LV_SIDE.png`]: await tile(200, 0, 0),
  [`${ICONS}/MACHINE_LV_TOP.png`]: await tile(0, 200, 0),
  [`${ICONS}/MACHINE_LV_BOTTOM.png`]: await tile(0, 0, 200),
};

describe("GregTech tier casings", () => {
  it("binds the hull's side, top and bottom, and skips tiers without a side hull", async () => {
    const { draft } = await heal({
      ...HULLS,
      [`${ICONS}/MACHINE_ULV_SIDE.png`]: await tile(50, 50, 50),
      // MV has only a top: no casing, a side is what makes one.
      [`${ICONS}/MACHINE_MV_TOP.png`]: await tile(1, 2, 3),
    });
    expect(Object.keys(draft.blocks).sort()).toEqual(["LV Machine Casing", "ULV Machine Casing"]);
    expect(faceOf(draft, "LV Machine Casing", "north")).toBe(`${HULL}/MACHINE_LV_SIDE`);
    expect(faceOf(draft, "LV Machine Casing", "east")).toBe(`${HULL}/MACHINE_LV_SIDE`);
    expect(faceOf(draft, "LV Machine Casing", "up")).toBe(`${HULL}/MACHINE_LV_TOP`);
    expect(faceOf(draft, "LV Machine Casing", "down")).toBe(`${HULL}/MACHINE_LV_BOTTOM`);
    // A missing top and bottom fall back to the side.
    expect(faceOf(draft, "ULV Machine Casing", "up")).toBe(`${HULL}/MACHINE_ULV_SIDE`);
    expect(faceOf(draft, "ULV Machine Casing", "down")).toBe(`${HULL}/MACHINE_ULV_SIDE`);
    expect(draft.block("LV Machine Casing")?.color).toBe(
      draft.texture(`${HULL}/MACHINE_LV_SIDE`)?.color,
    );
  });
});

describe("GregTech machines", () => {
  const lang = [
    "S:gt.blockmachines.basicmachine.bender.tier.01.name=Basic Bending Machine\r",
    "S:gt.blockmachines.basicmachine.bender.tier.02.name=Advanced Bending Machine",
    // Past the twelve tiers (and not a number at all): both ignored.
    "S:gt.blockmachines.basicmachine.bender.tier.13.name=Beyond",
    "S:gt.blockmachines.basicmachine.bender.tier.xx.name=Nonsense",
    "gt.blockmachines.basicmachine.e_furnace.tier.01.name=Basic Electric Furnace",
    "S:gt.blockmachines.basicmachine.alloysmelter.tier.01.name=Basic Alloy Smelter",
    "S:gt.blockmachines.basicmachine.unrelated.tier.01.name=Unused",
    "S:gt.blocktanks.tier.01.name=Not a machine",
  ].join("\n");

  const files = async () => ({
    ...HULLS,
    [`${ICONS}/MACHINE_MV_SIDE.png`]: await tile(0, 0, 150),
    [`${MACHINES}/bender/OVERLAY_FRONT.png`]: await overlay(),
    [`${MACHINES}/bender/OVERLAY_FRONT_ACTIVE.png`]: await overlay(),
    [`${MACHINES}/bender/OVERLAY_TOP.png`]: await overlay(),
    [`${MACHINES}/electric_furnace/OVERLAY_SIDE.png`]: await overlay(),
    [`${MACHINES}/alloy_smelter/OVERLAY_FRONT.png`]: await overlay(),
  });

  it("composites each overlay over the tier's hull and names the machine from the lang", async () => {
    const { draft } = await heal(await files(), lang);
    expect(draft.hasBlock("Basic Bending Machine")).toBe(true);
    expect(draft.hasBlock("Advanced Bending Machine")).toBe(true);
    // The front is the overlay over the side hull: its pixel on the hull's colour elsewhere.
    const front = faceOf(draft, "Basic Bending Machine", "north");
    expect(front).toBe("gregtech:heal/bender_lv/front");
    expect(pixel(draft, front ?? "", 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(draft, front ?? "", 1)).toEqual([200, 0, 0, 255]);
    // No side overlay, so the plain hull stands in for the other horizontals.
    expect(faceOf(draft, "Basic Bending Machine", "east")).toBe(`${HULL}/MACHINE_LV_SIDE`);
    // The top overlay sits on the top hull; the bottom is the plain bottom hull.
    const top = faceOf(draft, "Basic Bending Machine", "up");
    expect(pixel(draft, top ?? "", 1)).toEqual([0, 200, 0, 255]);
    expect(faceOf(draft, "Basic Bending Machine", "down")).toBe(`${HULL}/MACHINE_LV_BOTTOM`);
    // MV has a side hull only. Its top overlay has no top hull, so it goes over neutral grey;
    // the bottom has no overlay and no hull, so it takes the side.
    const mvFront = faceOf(draft, "Advanced Bending Machine", "north");
    expect(pixel(draft, mvFront ?? "", 1)).toEqual([0, 0, 150, 255]);
    const mvTop = faceOf(draft, "Advanced Bending Machine", "up");
    expect(pixel(draft, mvTop ?? "", 1)).toEqual([128, 128, 133, 255]);
    expect(faceOf(draft, "Advanced Bending Machine", "down")).toBe(`${HULL}/MACHINE_MV_SIDE`);
  });

  it("builds an Active variant only for a machine with an active front overlay", async () => {
    const { draft } = await heal(await files(), lang);
    expect(draft.hasBlock("Basic Bending Machine (Active)")).toBe(true);
    expect(faceOf(draft, "Basic Bending Machine (Active)", "north")).toBe(
      "gregtech:heal/bender_lv_active/front",
    );
    // Faces with no _ACTIVE overlay fall back to the idle overlay, drawn under the active key.
    expect(faceOf(draft, "Basic Bending Machine (Active)", "up")).toBe(
      "gregtech:heal/bender_lv_active/top",
    );
    expect(draft.hasBlock("Basic Electric Furnace (Active)")).toBe(false);
    expect(draft.hasBlock("Basic Alloy Smelter (Active)")).toBe(false);
  });

  it("maps the lang's abbreviated folder names, and ignores tiers it cannot place", async () => {
    const { draft } = await heal(await files(), lang);
    // electric_furnace is e_furnace in the lang; its side overlay becomes the sides.
    const side = faceOf(draft, "Basic Electric Furnace", "east");
    expect(side).toBe("gregtech:heal/electric_furnace_lv/side");
    expect(pixel(draft, side ?? "", 0)).toEqual([255, 255, 255, 255]);
    // A front without its own overlay is the plain hull, as the game draws it.
    expect(faceOf(draft, "Basic Electric Furnace", "north")).toBe(`${HULL}/MACHINE_LV_SIDE`);
    expect(draft.hasBlock("Basic Alloy Smelter")).toBe(true);
    expect(draft.hasBlock("Beyond")).toBe(false);
    expect(draft.hasBlock("Nonsense")).toBe(false);
    expect(draft.hasBlock("Unused")).toBe(false);
  });

  it("names a machine the lang lacks from its folder, for every tier, and warns once", async () => {
    const { draft, warnings } = await heal({
      ...HULLS,
      [`${MACHINES}/chemical_reactor/OVERLAY_FRONT.png`]: await overlay(),
      [`${MACHINES}/macerator3x/OVERLAY_SIDE.png`]: await overlay(),
    });
    expect(warnings.filter((w) => w.includes("GregTech.lang not found"))).toHaveLength(1);
    expect(draft.hasBlock("Chemical Reactor (LV)")).toBe(true);
    expect(draft.hasBlock("Chemical Reactor (UMV)")).toBe(true);
    expect(draft.hasBlock("Macerator 3x (HV)")).toBe(true);
    // Tiers with no hull composite over neutral grey rather than being dropped.
    const front = faceOf(draft, "Chemical Reactor (UMV)", "north") ?? "";
    expect(pixel(draft, front, 1)).toEqual([128, 128, 133, 255]);
  });

  it("keeps same-named machines apart", async () => {
    const twin = [
      "S:gt.blockmachines.basicmachine.a.tier.01.name=Twin",
      "S:gt.blockmachines.basicmachine.b.tier.01.name=Twin",
    ].join("\n");
    const { draft } = await heal(
      {
        ...HULLS,
        [`${MACHINES}/a/OVERLAY_FRONT.png`]: await overlay(),
        [`${MACHINES}/b/OVERLAY_FRONT.png`]: await overlay(),
      },
      twin,
    );
    expect(draft.hasBlock("Twin")).toBe(true);
    expect(draft.hasBlock("Twin 2")).toBe(true);
    expect(faceOf(draft, "Twin", "north")).toBe("gregtech:heal/a_lv/front");
    expect(faceOf(draft, "Twin 2", "north")).toBe("gregtech:heal/b_lv/front");
  });
});

describe("GregTech roster cubes superseded by the heal", () => {
  it("removes overlay-only and hull-only cubes, keeps anything with other art", async () => {
    const seed = (draft: LibraryDraft) => {
      const keys = {
        overlay: `${"gregtech:blocks/basicmachines"}/bender/OVERLAY_FRONT`,
        hull: `${HULL}/MACHINE_LV_SIDE`,
        coke: "gregtech:blocks/COKE_OVEN_CASING",
      };
      for (const key of Object.values(keys)) {
        draft.addTexture(key, textureOf(solid(9, 9, 9, 255), 16));
      }
      const cube = (name: string, faces: Record<string, string>) =>
        draft.addCube(name, faces, { modelKey: `gregtech:nei/${name}` });
      cube("Overlay Only", { north: keys.overlay, up: keys.overlay });
      cube("Raw Hull", { north: keys.hull });
      cube("Mixed", { north: keys.hull, up: keys.coke });
      cube("Coke Oven Casing", { north: keys.coke });
    };
    const { draft } = await heal({ ...HULLS }, "", seed);
    expect(draft.hasBlock("Overlay Only")).toBe(false);
    expect(draft.hasBlock("Raw Hull")).toBe(false);
    expect(draft.hasBlock("Mixed")).toBe(true);
    expect(draft.hasBlock("Coke Oven Casing")).toBe(true);
    // What the heal itself added, from the very same hull textures, is not removed.
    expect(draft.hasBlock("LV Machine Casing")).toBe(true);
  });
});
