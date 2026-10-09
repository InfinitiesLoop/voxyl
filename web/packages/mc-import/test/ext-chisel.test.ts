import { describe, expect, it } from "vitest";
import { healChisel } from "../src/extensions/chisel.ts";
import { parseChiselLang, prettifyGroup } from "../src/extensions/chisel-lang.ts";
import { bytesSource, ZipAssetSource } from "../src/index.ts";
import { LibraryDraft } from "../src/legacy/draft.ts";
import { HealContext } from "../src/legacy/heal.ts";
import { TextureIngest } from "../src/legacy/texture.ts";
import { png, solid, zip } from "./helpers.ts";

const T = "chisel/textures/blocks";

/** A Chisel jar: PNGs by path under `chisel/textures/blocks` (one colour each), plus raw files. */
async function chiselJar(
  textures: Record<string, [number, number, number]>,
  extra: Record<string, Uint8Array | string> = {},
) {
  const files: Record<string, Uint8Array | string> = { ...extra };
  for (const [path, [r, g, b]] of Object.entries(textures)) {
    files[`assets/${T}/${path}.png`] = await png(16, 16, solid(r, g, b));
  }
  return ZipAssetSource.open("chisel.jar", bytesSource(await zip(files)));
}

async function heal(
  source: Awaited<ReturnType<typeof chiselJar>>,
  draft = new LibraryDraft("chisel"),
  legacyIdFor?: (registry: string) => number,
) {
  const ingest = new TextureIngest();
  const ctx = new HealContext({
    draft,
    source,
    ns: "chisel",
    ingest,
    ...(legacyIdFor && { legacyIdFor }),
  });
  await healChisel(ctx);
  return { draft, warnings: ingest.warnings };
}

const faceTextures = (draft: LibraryDraft, name: string) => {
  const model = draft.block(name)?.variants?.[""]?.model ?? "";
  return Object.fromEntries(
    Object.entries(draft.models[model]?.elements[0]?.faces ?? {}).map(([s, f]) => [s, f.texture]),
  );
};

const LANG = `
# Chisel
tile.chisel.andesite.name=Andesite
tile.andesite.0.desc=Generates in your world
tile.andesite.1.desc=Polished Andesite
tile.chisel.glass_pane.name=Glass Pane
tile.glass_pane.1.desc=Bubble Pane
white.bubble.desc=White Bubble Glass
white.pane.bubble.desc=White Bubble Pane
darkgray.pane.glass.fancy.desc=Dark Gray Fancy Pane
lime.glass.noborder.desc=Lime Borderless Glass
`;

describe("healChisel", () => {
  it("resolves bare, group-prefixed and top+side textures, and names them from the lang", async () => {
    const source = await chiselJar(
      {
        "andesite/andesite": [10, 20, 30],
        "andesite/andesitePolished": [11, 21, 31],
        "andesite/andesitePillar-top": [200, 0, 0],
        "andesite/andesitePillar-ctmv": [0, 200, 0],
        "andesite/andesiteLBrick": [12, 22, 32],
        "carpet/white": [250, 250, 250],
        "antiblock/black-antiBlock": [1, 1, 1],
      },
      { "assets/chisel/lang/en_US.lang": LANG },
    );
    const { draft } = await heal(source);

    // Bare file, six faces; meta 0 takes the group's name, not the tooltip.
    const tex = "chisel:blocks/andesite/andesite";
    expect(faceTextures(draft, "Andesite")).toEqual({
      up: tex,
      down: tex,
      north: tex,
      south: tex,
      east: tex,
      west: tex,
    });
    expect(draft.block("Andesite")?.mc).toEqual({ registry: "chisel:andesite", meta: 0 });
    expect(draft.block("Andesite")?.color).toBe("#0a141e");

    // Meta 1 uses the variant's .desc; meta 3 has none and falls back to "<group> <meta>".
    expect(draft.block("Polished Andesite")?.mc).toEqual({ registry: "chisel:andesite", meta: 1 });
    expect(draft.block("Andesite 3")?.mc?.meta).toBe(3);

    // A pillar: "-top" on up and down, "-ctmv" standing in for the missing "-side".
    const top = "chisel:blocks/andesite/andesitePillar-top";
    const ctmv = "chisel:blocks/andesite/andesitePillar-ctmv";
    expect(faceTextures(draft, "Andesite 2")).toEqual({
      up: top,
      down: top,
      north: ctmv,
      south: ctmv,
      east: ctmv,
      west: ctmv,
    });

    // The file sits under a folder named for the group: group "carpet", base "white".
    expect(faceTextures(draft, "Carpet").north).toBe("chisel:blocks/carpet/white");
    // No lang name at all: the group folder name as words (camelCase split).
    expect(draft.block("Anti Block")?.mc?.registry).toBe("chisel:antiBlock");
  });

  it("warns for each table row it cannot resolve and skips it", async () => {
    const { draft, warnings } = await heal(await chiselJar({ "andesite/andesite": [1, 2, 3] }));
    expect(draft.hasBlock("Andesite")).toBe(true);
    expect(draft.hasBlock("Andesite 1")).toBe(false);
    expect(warnings).toContain(
      "chisel: no texture match for chisel:andesite meta 1 (andesite/andesitePolished), skipped",
    );
  });

  it("keeps the name of the block a previous run made for the same identity", async () => {
    const source = await chiselJar({ "andesite/andesite": [1, 2, 3] });
    const draft = new LibraryDraft("chisel");
    draft.addBlock("Old Name", { color: "#000000", mc: { registry: "chisel:andesite", meta: 0 } });
    await heal(source, draft);
    expect(draft.hasBlock("Andesite")).toBe(false);
    expect(faceTextures(draft, "Old Name").up).toBe("chisel:blocks/andesite/andesite");
    // Running again over its own output adds nothing.
    const before = Object.keys(draft.blocks).length;
    await heal(source, draft);
    expect(Object.keys(draft.blocks)).toHaveLength(before);
  });

  it("records the install's legacy block id when it knows one", async () => {
    const source = await chiselJar({ "andesite/andesite": [1, 2, 3] });
    const { draft } = await heal(source, undefined, (r) => (r === "chisel:andesite" ? 2075 : -1));
    expect(draft.block("Andesite")?.mc).toEqual({
      registry: "chisel:andesite",
      meta: 0,
      legacyId: 2075,
    });
  });

  it("heals pane groups to real pane geometry: rim from -top, flat face from the side file", async () => {
    const source = await chiselJar(
      {
        "glasspane/terrain-glassbubble-top": [255, 0, 0],
        "glasspane/terrain-glassbubble-ctmv": [0, 0, 255],
        // The "Screen Pane": one bare file, no top/side split, so it plays both roles.
        "glasspane/terrain-glass-screen": [0, 255, 0],
        "glasspanedyed/white-bubble-top": [250, 250, 250],
        "glasspanedyed/white-bubble-side": [240, 240, 240],
      },
      { "assets/chisel/lang/en_US.lang": LANG },
    );
    const { draft } = await heal(source);

    const bubble = draft.block("Bubble Pane");
    expect(bubble?.multipart).toBeDefined();
    expect(bubble?.transparent).toBe(true);
    expect(bubble?.color).toBe("#0000ff");
    expect(bubble?.mc).toEqual({ registry: "chisel:glass_pane", meta: 1 });
    const post = draft.models["chisel:heal/Bubble Pane/post"]?.elements[0]?.faces;
    expect(post?.up?.texture).toBe("chisel:blocks/glasspane/terrain-glassbubble-top");
    const side = draft.models["chisel:heal/Bubble Pane/side"]?.elements[0]?.faces;
    expect(side?.east?.texture).toBe("chisel:blocks/glasspane/terrain-glassbubble-ctmv");
    expect(side?.north?.texture).toBe("chisel:blocks/glasspane/terrain-glassbubble-top");

    // Single-texture mode: the same file for both roles.
    expect(draft.block("Glass Pane 3")?.multipart).toBeDefined();
    const screenSide = draft.models["chisel:heal/Glass Pane 3/side"]?.elements[0]?.faces;
    expect(screenSide?.east?.texture).toBe("chisel:blocks/glasspane/terrain-glass-screen");
    expect(screenSide?.north?.texture).toBe("chisel:blocks/glasspane/terrain-glass-screen");

    // Dyed pane family: a real name even at meta 0, from "<color>.pane.<style>.desc".
    expect(draft.block("White Bubble Pane")?.mc).toEqual({
      registry: "chisel:stained_glass_pane_white",
      meta: 0,
    });
    // A cube group makes no multipart block.
    expect(draft.block("Andesite")?.multipart).toBeUndefined();
  });

  it("crops a fixed icon for the fake-controller screens", async () => {
    // A 32x32 frame of four different 16x16 icons: the top-left one is what the block shows.
    const rgba = new Uint8Array(32 * 32 * 4);
    const colours: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ];
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const [r, g, b] = colours[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)] ?? [0, 0, 0];
        rgba.set([r, g, b, 255], (y * 32 + x) * 4);
      }
    }
    const source = await ZipAssetSource.open(
      "chisel.jar",
      bytesSource(
        await zip({ [`assets/${T}/futura/WIP/controller.png`]: await png(32, 32, rgba) }),
      ),
    );
    const { draft } = await heal(source);
    const key = "chisel:heal/icon_futura_WIP_controller";
    expect(draft.texture(key)?.size).toBe(16);
    expect(draft.texture(key)?.color).toBe("#ff0000");
    expect(draft.block("Futura 2")?.mc).toEqual({ registry: "chisel:futura", meta: 2 });
    expect(new Set(Object.values(faceTextures(draft, "Futura 2")))).toEqual(new Set([key]));
  });
});

describe("parseChiselLang", () => {
  const lang = parseChiselLang(LANG);

  it("reads group names and variant descriptions and ignores the rest", () => {
    expect(lang.get("chisel.andesite")).toBe("Andesite");
    expect(lang.get("andesite.1")).toBe("Polished Andesite");
    expect(lang.get("andesite.0")).toBe("Generates in your world");
    expect(lang.get("white.bubble.desc")).toBeUndefined();
  });

  it("names the dyed glass families from their own key shape", () => {
    // The plain family: 4 colours per block, so lime (base 4) + noborder (3).
    expect(lang.get("SGP_DISPLAY:stained_glass_lime:7")).toBe("Lime Borderless Glass");
    expect(lang.get("SGP_DISPLAY:stained_glass_white:0")).toBe("White Bubble Glass");
    // The pane family: 2 colours per block; gray is "darkgray" in the lang, base 8, fancy + 2.
    expect(lang.get("SGP_DISPLAY:stained_glass_pane_white:0")).toBe("White Bubble Pane");
    expect(lang.get("SGP_DISPLAY:stained_glass_pane_gray:10")).toBe("Dark Gray Fancy Pane");
  });

  it("copes with a missing file and CRLF", () => {
    expect(parseChiselLang("").size).toBe(0);
    expect(parseChiselLang("tile.chisel.x.name=X\r\n").get("chisel.x")).toBe("X");
  });
});

describe("prettifyGroup", () => {
  it("matches Godot's capitalize() on group folder names", () => {
    expect(prettifyGroup("antiBlock")).toBe("Anti Block");
    expect(prettifyGroup("carpet_block")).toBe("Carpet Block");
    expect(prettifyGroup("hexPlating2")).toBe("Hex Plating 2");
    expect(prettifyGroup("iron_bars")).toBe("Iron Bars");
    expect(prettifyGroup("redstone")).toBe("Redstone");
  });
});
