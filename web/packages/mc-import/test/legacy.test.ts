import { describe, expect, it } from "vitest";
import { bytesSource, ZipAssetSource } from "../src/index.ts";
import {
  baseTokens,
  type Candidate,
  faceOf,
  matchesBase,
  resolveFaces,
  TextureIndex,
  tokenize,
} from "../src/legacy/attach.ts";
import { parseCsv } from "../src/legacy/csv.ts";
import { LibraryDraft } from "../src/legacy/draft.ts";
import { neiManifest } from "../src/legacy/manifest.ts";
import {
  NeiDumpError,
  NeiRoster,
  parseBlockCsv,
  parseItemCsv,
  parseItemPanelCsv,
  parseNeiDumps,
} from "../src/legacy/nei.ts";
import { importRoster } from "../src/legacy/roster.ts";
import { TextureIngest } from "../src/legacy/texture.ts";
import { png, solid, zip } from "./helpers.ts";

const lines = (...rows: string[]) => rows.join("\n");
const ITEM = "Name,ID,Has Block,Mod,Class,Display Name";
const PANEL = "Item Name,Item ID,Item meta,Has NBT,Display Name";
const BLOCK = "Name,ID,Has Item,Mod,Class,Display Name";

/** A texture file of one colour, the way a mod stores it. */
const tex = (r: number, g = r, b = r) => png(16, 16, solid(r, g, b));

/** A source from files under `assets/`. */
async function source(files: Record<string, Uint8Array | string>, label = "test.jar") {
  const prefixed = Object.fromEntries(Object.entries(files).map(([k, v]) => [`assets/${k}`, v]));
  return ZipAssetSource.open(label, bytesSource(await zip(prefixed)));
}

function roster(items: string[], panel: string[]): NeiRoster {
  return new NeiRoster(
    parseItemCsv(lines(ITEM, ...items)),
    parseItemPanelCsv(lines(PANEL, ...panel)),
  );
}

describe("csv", () => {
  it("reads quoted fields, escaped quotes, embedded commas and line breaks", () => {
    expect(parseCsv('a,"b,c","say ""hi""","x\ny"\r\n1,2,3,4\r\n')).toEqual([
      ["a", "b,c", 'say "hi"', "x\ny"],
      ["1", "2", "3", "4"],
    ]);
  });

  it("keeps empty fields, a quote that isn't at a field start, and blank lines", () => {
    expect(parseCsv('a,,c,\n5" pipe,"",x\n\nlast')).toEqual([
      ["a", "", "c", ""],
      ['5" pipe', "", "x"],
      [""],
      ["last"],
    ]);
  });

  it("does not make a record out of a final line break, or of nothing", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("NEI dumps", () => {
  it("keeps Has Block rows and the numeric id, and ignores short rows", () => {
    const placeable = parseItemCsv(
      lines(
        ITEM,
        "testmod:widget,100,true,TestMod,some.Class,Widget",
        "testmod:gadget,101,false,TestMod,some.Class,Gadget",
        "testmod:noid,abc,true,TestMod,some.Class,No Id",
        "short,1,true",
        ",3,true,TestMod,c,Nameless",
      ),
    );
    expect([...placeable.keys()]).toEqual(["testmod:widget", "testmod:noid"]);
    expect(placeable.get("testmod:widget")).toEqual({
      mod: "TestMod",
      ns: "testmod",
      legacyId: 100,
    });
    expect(placeable.get("testmod:noid")?.legacyId).toBe(-1);
  });

  it("groups the panel rows of placeable registries by mod, in file order", () => {
    const r = roster(
      [
        "testmod:widget,100,true,TestMod,c,Widget",
        "testmod:gadget,101,false,TestMod,c,Gadget",
        "BuildCraft|Core:gear,104,true,BuildCraft|Core,c,Gear",
      ],
      [
        "testmod:widget,100,0,false,Widget",
        "testmod:gadget,101,0,false,Gadget",
        "BuildCraft|Core:gear,104,0,false,Gear",
        "testmod:widget,100,notanumber,false,Broken",
        'testmod:widget,100,3,false,"Widget, Large"',
      ],
    );
    expect(r.mods).toEqual(["BuildCraft|Core", "TestMod"]);
    expect(r.entries("TestMod").map((e) => [e.registry, e.meta, e.display])).toEqual([
      ["testmod:widget", 0, "Widget"],
      ["testmod:widget", 3, "Widget, Large"],
    ]);
    expect(r.entries("BuildCraft|Core")[0]).toMatchObject({ ns: "BuildCraft|Core", legacyId: 104 });
  });

  it("reads block ids, and looks an id up block.csv first, then item.csv", () => {
    const r = new NeiRoster(
      parseItemCsv(lines(ITEM, "a:one,5,true,A,c,One", "a:two,6,true,A,c,Two")),
      [],
      parseBlockCsv(
        lines(
          BLOCK,
          "a:one,50,true,A,c,One",
          "ForgeMultipart:block,202,false,F,c,",
          "x:bad,zz,true,A,c,",
        ),
      ),
    );
    expect(r.legacyIdFor("a:one")).toBe(50);
    expect(r.legacyIdFor("a:two")).toBe(6);
    expect(r.legacyIdFor("ForgeMultipart:block")).toBe(202);
    expect(r.legacyIdFor("x:bad")).toBe(-1);
    expect(r.legacyIdFor("nothing:here")).toBe(-1);
  });

  it("refuses a wrong header with the file named, and a missing file", () => {
    expect(() => parseItemCsv("Nope,ID\n1,2")).toThrow(
      "item.csv doesn't look like an NEI item dump (unexpected header)",
    );
    expect(() => parseItemPanelCsv(lines(ITEM))).toThrow(
      "itempanel.csv doesn't look like an NEI Item Panel dump (unexpected header)",
    );
    expect(() => parseBlockCsv(lines(PANEL))).toThrow(
      "block.csv doesn't look like an NEI block dump (unexpected header)",
    );
    expect(() => parseNeiDumps({ item: null, itempanel: "", block: "" })).toThrow(NeiDumpError);
    expect(() => parseNeiDumps({ item: ITEM, itempanel: PANEL, block: null })).toThrow(
      "couldn't find block.csv — run NEI's Data Dumps (Blocks) too, next to the others",
    );
    const ok = parseNeiDumps({ item: ITEM, itempanel: PANEL, block: BLOCK });
    expect(ok.mods).toEqual([]);
  });

  it("lets a byte order mark through the header check", () => {
    expect(parseItemCsv(`﻿${lines(ITEM, "a:b,1,true,M,c,B")}`).size).toBe(1);
  });
});

describe("tokens", () => {
  it("splits on separators and camelCase boundaries", () => {
    expect(tokenize("korp_ (4)")).toEqual(["korp", "4"]);
    expect(tokenize("BlockControllerColumn")).toEqual(["block", "controller", "column"]);
    expect(tokenize("gt.blockmachines")).toEqual(["gt", "blockmachines"]);
    expect(tokenize("ancient_debris_top")).toEqual(["ancient", "debris", "top"]);
    expect(tokenize("MACHINE_LV_SIDE")).toEqual(["machine", "lv", "side"]);
    expect(tokenize("BlockCraftingStorage4k")).toEqual(["block", "crafting", "storage4k"]);
    expect(tokenize("a4Block")).toEqual(["a4", "block"]);
  });

  it("makes base tokens of a registry's local part", () => {
    expect(baseTokens("Ztones:tile.korpBlock")).toEqual(["korp"]);
    expect(baseTokens("gregtech:gt.blockmachines")).toEqual(["gt", "blockmachines"]);
    expect(baseTokens("etfuturum:ancient_debris")).toEqual(["ancient", "debris"]);
    expect(baseTokens("etfuturum:copper_block")).toEqual(["copper"]);
    expect(baseTokens("x:TILE.Thing")).toEqual(["thing"]);
    // A lone "block" is the whole name, not a suffix to strip.
    expect(baseTokens("x:block")).toEqual(["block"]);
    expect(baseTokens("stone")).toEqual(["stone"]);
    expect(baseTokens("x:__")).toEqual([]);
  });

  it("matches only the base followed by suffix words", () => {
    const base = ["copper"];
    expect(matchesBase(["copper"], base)).toBe(true);
    expect(matchesBase(["copper", "block"], base)).toBe(true);
    expect(matchesBase(["copper", "top", "on"], base)).toBe(true);
    expect(matchesBase(["copper", "3"], base)).toBe(true);
    expect(matchesBase(["copper", "barrel", "bottom"], base)).toBe(false);
    expect(matchesBase(["ancient"], ["ancient", "debris"])).toBe(false);
    expect(matchesBase(["debris"], ["ancient", "debris"])).toBe(false);
    expect(matchesBase(["x"], [])).toBe(false);
  });

  it("finds the face word once numbers and states are stripped", () => {
    expect(faceOf(["furnace", "front", "on"])).toBe("front");
    expect(faceOf(["korp", "4"])).toBe("");
    expect(faceOf(["block", "controller"])).toBe("");
    expect(faceOf(["top"])).toBe("top");
    expect(faceOf(["on"])).toBe("");
  });
});

describe("face resolution", () => {
  const cand = (file: string, subdir: Candidate["subdir"] = "blocks"): Candidate => ({
    name: file,
    subdir,
    toks: tokenize(file.slice(file.lastIndexOf("/") + 1)),
  });

  it("binds a plain texture to every side, but only for meta 0", () => {
    const faces = resolveFaces([cand("widget")], 0);
    expect(Object.values(faces ?? {}).every((c) => c.name === "widget")).toBe(true);
    expect(Object.keys(faces ?? {}).sort()).toEqual([
      "down",
      "east",
      "north",
      "south",
      "up",
      "west",
    ]);
    expect(resolveFaces([cand("widget")], 1)).toBeNull();
  });

  it("is ambiguous, so a miss, with several plain files and no face word", () => {
    expect(resolveFaces([cand("widget"), cand("widget_block")], 0)).toBeNull();
    expect(resolveFaces([], 0)).toBeNull();
  });

  it("fills sides from face words, a narrower word first, the plain file filling the rest", () => {
    const faces = resolveFaces([cand("pillar_side"), cand("pillar_top"), cand("pillar")], 0);
    expect(faces?.up?.name).toBe("pillar_top");
    expect(faces?.north?.name).toBe("pillar_side");
    expect(faces?.west?.name).toBe("pillar_side");
    expect(faces?.down?.name).toBe("pillar");
    // end covers up and down, but a "top" file keeps up.
    const ends = resolveFaces([cand("log_end"), cand("log_top"), cand("log_side")], 0);
    expect(ends?.up?.name).toBe("log_top");
    expect(ends?.down?.name).toBe("log_end");
    expect(ends?.east?.name).toBe("log_side");
  });

  it("uses the first face file for the rest when there is no plain one, and the first of a repeated word", () => {
    const faces = resolveFaces([cand("m_front_on"), cand("m_front"), cand("m_top")], 0);
    expect(faces?.north?.name).toBe("m_front_on");
    expect(faces?.up?.name).toBe("m_top");
    expect(faces?.south?.name).toBe("m_front_on");
  });

  it("with several plain files and a face word, the first plain file is the default", () => {
    const faces = resolveFaces([cand("a_top"), cand("a"), cand("a_block")], 0);
    expect(faces?.down?.name).toBe("a");
  });

  it("picks a meta-packed block's own file for every side, and nothing for a meta it lacks", () => {
    const files = [cand("wool_0"), cand("wool_1"), cand("wool_5")];
    expect(resolveFaces(files, 1)?.north?.name).toBe("wool_1");
    expect(resolveFaces(files, 5)?.down?.name).toBe("wool_5");
    expect(resolveFaces(files, 2)).toBeNull();
    // meta 0 does not fall back to a plain file when numbered ones exist.
    expect(resolveFaces([...files, cand("wool")], 3)).toBeNull();
  });

  it("drops a number carried by two files rather than choosing", () => {
    const files = [cand("wool_1"), cand("sub/wool_1"), cand("wool_2")];
    expect(resolveFaces(files, 1)).toBeNull();
    expect(resolveFaces(files, 2)?.up?.name).toBe("wool_2");
  });

  it("indexes a listing by first token, keeping its order", () => {
    const index = new TextureIndex([
      "copper_block.png",
      "copper_barrel_top.png",
      "sub/copper_2.png",
      "readme.txt",
      "Copper_top.png",
      "zinc.png",
    ]);
    expect(index.matching(["copper"]).map((c) => c.name)).toEqual([
      "copper_block",
      "sub/copper_2",
      "Copper_top",
    ]);
    expect(index.matching(["copper", "barrel"]).map((c) => c.name)).toEqual(["copper_barrel_top"]);
    expect(index.matching(["nothing"])).toEqual([]);
  });
});

describe("texture ingest", () => {
  it("keeps the first frame of an animated strip and classifies alpha", async () => {
    const strip = new Uint8Array(16 * 48 * 4);
    strip.set(solid(10, 20, 30), 0);
    strip.set(solid(200, 0, 0), 16 * 16 * 4);
    strip.set(solid(0, 200, 0), 16 * 32 * 4);
    const src = await source({
      "m/textures/blocks/anim.png": await png(16, 48, strip),
      "m/textures/blocks/glass.png": await png(16, 16, solid(5, 5, 5, 0)),
      "m/textures/blocks/odd.png": await png(16, 20, solid(1, 1, 1)),
      "m/textures/blocks/tall.png": await png(16, 24, solid(1, 1, 1).subarray(0, 16 * 24 * 4)),
      "m/textures/blocks/tall.png.mcmeta": '{"animation":{}}',
      "m/textures/blocks/wide.png": await png(32, 16, new Uint8Array(32 * 16 * 4).fill(255)),
    });
    const draft = new LibraryDraft("m");
    const ingest = new TextureIngest();
    expect(await ingest.ensure(draft, src, "m:blocks/anim")).toBe("m:blocks/anim");
    const anim = draft.texture("m:blocks/anim");
    expect(anim?.size).toBe(16);
    expect(anim?.rgba.length).toBe(16 * 16 * 4);
    expect(anim?.color).toBe("#0a141e");
    expect(anim?.alpha).toBe("opaque");

    await ingest.ensure(draft, src, "m:blocks/glass");
    expect(draft.texture("m:blocks/glass")?.alpha).toBe("cutout");

    expect(await ingest.ensure(draft, src, "m:blocks/odd")).toBeNull();
    expect(await ingest.ensure(draft, src, "m:blocks/wide")).toBeNull();
    expect(await ingest.ensure(draft, src, "m:blocks/tall")).toBe("m:blocks/tall");
    expect(draft.texture("m:blocks/tall")?.size).toBe(16);
    expect(await ingest.ensure(draft, src, "m:blocks/gone")).toBeNull();
    await ingest.ensure(draft, src, "m:blocks/gone"); // warned once
    expect(ingest.warnings).toEqual([
      "texture image not square (16x20), skipped: m:blocks/odd",
      "texture image not square (32x16), skipped: m:blocks/wide",
      "texture image missing: m:blocks/gone",
    ]);
  });

  it("reads each file once per source, whatever drafts ask", async () => {
    const src = await source({ "m/textures/blocks/a.png": await tex(9) });
    const ingest = new TextureIngest();
    const one = new LibraryDraft("one");
    const two = new LibraryDraft("two");
    await ingest.ensure(one, src, "m:blocks/a");
    await ingest.ensure(two, src, "m:blocks/a");
    expect(one.texture("m:blocks/a")).toBe(two.texture("m:blocks/a"));
  });
});

describe("library draft", () => {
  it("builds a cube: culling for opaque faces, transparency, the top face's colour", async () => {
    const src = await source({
      "m/textures/blocks/top.png": await tex(200, 0, 0),
      "m/textures/blocks/side.png": await tex(0, 200, 0),
      "m/textures/blocks/pane.png": await png(16, 16, solid(1, 2, 3, 0)),
    });
    const draft = new LibraryDraft("m");
    const ingest = new TextureIngest();
    for (const t of ["top", "side", "pane"]) await ingest.ensure(draft, src, `m:blocks/${t}`);
    const block = draft.addCube("Pillar", {
      down: "m:blocks/side",
      up: "m:blocks/top",
      north: "m:blocks/side",
    });
    expect(block).toEqual({
      variants: { "": { model: "m:heal/Pillar" } },
      color: "#c80000",
    });
    expect(draft.models["m:heal/Pillar"]?.elements[0]).toEqual({
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: {
        down: { texture: "m:blocks/side", cullface: "down" },
        up: { texture: "m:blocks/top", cullface: "up" },
        north: { texture: "m:blocks/side", cullface: "north" },
      },
    });
    const glass = draft.addCube(
      "Glass",
      { up: "m:blocks/pane", north: "m:blocks/side" },
      { modelKey: "m:nei/Glass" },
    );
    expect(glass?.transparent).toBe(true);
    expect(draft.models["m:nei/Glass"]?.elements[0]?.faces.up).toEqual({
      texture: "m:blocks/pane",
    });
    // Nothing to draw adds nothing.
    expect(draft.addCube("Empty", { up: "m:blocks/nope" })).toBeNull();
    expect(draft.hasBlock("Empty")).toBe(false);
  });

  it("finds blocks by identity, updates in place, and mints unique names", () => {
    const draft = new LibraryDraft("m");
    draft.addBlock("Widget", { color: "#111111", mc: { registry: "m:widget", meta: 2 } });
    draft.addBlock("Plain", { color: "#222222", mc: { registry: "m:plain" } });
    expect(draft.findByIdentity("m:widget", 2)?.name).toBe("Widget");
    expect(draft.findByIdentity("m:widget")).toBeUndefined();
    expect(draft.findByIdentity("m:plain")?.name).toBe("Plain");
    expect(draft.uniqueName("Free")).toBe("Free");
    expect(draft.uniqueName("Widget")).toBe("Widget 2");
    draft.addBlock("Widget 2", { color: "#333333" });
    expect(draft.uniqueName("Widget")).toBe("Widget 3");
    expect(draft.uniqueName("Widget", (b, n) => `${b} (${n})`)).toBe("Widget (2)");
    draft.removeBlock("Widget");
    expect(draft.findByIdentity("m:widget", 2)).toBeUndefined();
    expect(draft.uniqueName("Widget")).toBe("Widget");
    // Odd names are only names.
    draft.addBlock("constructor", { color: "#000000" });
    expect(draft.hasBlock("constructor")).toBe(true);
    expect(draft.hasBlock("toString")).toBe(false);
  });

  it("carries on from an existing library without changing it", () => {
    const base = new LibraryDraft("m");
    base.addBlock("A", { color: "#111111", mc: { registry: "m:a", meta: 0 } });
    const lib = base.toLibrary();
    const next = new LibraryDraft("m", "M", lib);
    expect(next.findByIdentity("m:a")?.name).toBe("A");
    next.addBlock("B", { color: "#222222" });
    expect(Object.keys(lib.blocks)).toEqual(["A"]);
    expect(Object.keys(next.toLibrary().blocks)).toEqual(["A", "B"]);
  });
});

describe("roster import", () => {
  /** The faces an imported block's single cube draws. */
  const facesOf = (draft: LibraryDraft, name: string) => {
    const model = draft.block(name)?.variants?.[""]?.model ?? "";
    return Object.fromEntries(
      Object.entries(draft.models[model]?.elements[0]?.faces ?? {}).map(([s, f]) => [s, f.texture]),
    );
  };

  async function run(
    r: NeiRoster,
    sources: Awaited<ReturnType<typeof source>>[],
    opts: { mods?: string[]; draft?: LibraryDraft } = {},
  ) {
    const drafts = new Map<string, LibraryDraft>();
    const draft = opts.draft;
    const result = await importRoster({
      roster: r,
      sources,
      libraries: (ns) => {
        if (draft) return draft;
        let d = drafts.get(ns);
        if (!d) {
          d = new LibraryDraft(ns.toLowerCase());
          drafts.set(ns, d);
        }
        return d;
      },
      ...(opts.mods && { mods: opts.mods }),
    });
    return { result, drafts, draft: draft ?? [...drafts.values()][0] };
  }

  it("imports confirmed entries, drops the textureless, and names them by display", async () => {
    const r = roster(
      [
        "testmod:widget,100,true,TestMod,c,Widget",
        "testmod:machine,101,true,TestMod,c,Machine",
        "testmod:wool,102,true,TestMod,c,Wool",
        "testmod:gadget,103,false,TestMod,c,Gadget",
        "BuildCraft|Core:gear,104,true,BuildCraft|Core,c,Gear",
        "Ztones:tile.korpBlock,105,true,Ztones,c,Korp",
        "testmod:ancient_debris,106,true,TestMod,c,Ancient Debris",
      ],
      [
        "testmod:widget,100,0,false,Widget",
        "testmod:machine,101,0,false,Basic Machine",
        "testmod:machine,101,5,false,Advanced Machine",
        "testmod:wool,102,0,false,White Wool",
        "testmod:wool,102,1,false,Orange Wool",
        "testmod:gadget,103,0,false,Gadget",
        "BuildCraft|Core:gear,104,0,false,Gear",
        "Ztones:tile.korpBlock,105,0,false,Korp",
        "testmod:ancient_debris,106,0,false,Ancient Debris",
      ],
    );
    const main = await source({
      "testmod/textures/blocks/widget.png": await tex(50, 150, 230),
      "testmod/textures/blocks/wool_0.png": await tex(240),
      "testmod/textures/blocks/wool_1.png": await tex(230, 130, 25),
      "testmod/textures/blocks/ancient_debris.png": await tex(128, 77, 77),
      "buildcraftcore/textures/blocks/gear.png": await tex(150, 150, 25),
    });
    const ztones = await source(
      { "ztones/textures/blocks/korp.png": await tex(100, 50, 150) },
      "z.jar",
    );
    const { result, drafts } = await run(r, [main, ztones]);

    expect(result.dropped.map((d) => [d.registry, d.meta, d.display])).toEqual([
      ["testmod:machine", 0, "Basic Machine"],
      ["testmod:machine", 5, "Advanced Machine"],
    ]);
    expect(result.droppedByMod).toEqual({ TestMod: 2 });
    expect(result.warnings).toEqual(["no texture match, dropped: 2 block(s) in TestMod"]);
    expect(result.imported.map((e) => [e.mod, e.registry, e.meta, e.name])).toEqual([
      ["BuildCraft|Core", "BuildCraft|Core:gear", 0, "Gear"],
      ["TestMod", "testmod:widget", 0, "Widget"],
      ["TestMod", "testmod:wool", 0, "White Wool"],
      ["TestMod", "testmod:wool", 1, "Orange Wool"],
      ["TestMod", "testmod:ancient_debris", 0, "Ancient Debris"],
      ["Ztones", "Ztones:tile.korpBlock", 0, "Korp"],
    ]);

    const testmod = drafts.get("testmod");
    expect(testmod?.block("Widget")).toMatchObject({
      color: "#3296e6",
      mc: { registry: "testmod:widget", meta: 0, legacyId: 100 },
    });
    expect(facesOf(testmod as LibraryDraft, "White Wool").up).toBe("testmod:blocks/wool_0");
    expect(facesOf(testmod as LibraryDraft, "Orange Wool").west).toBe("testmod:blocks/wool_1");
    expect(facesOf(testmod as LibraryDraft, "Ancient Debris").up).toBe(
      "testmod:blocks/ancient_debris",
    );
    expect(testmod?.block("Machine")).toBeUndefined();
    // The model is keyed by the texture namespace and the block name, as Godot names it.
    expect(testmod?.block("Widget")?.variants?.[""]?.model).toBe("testmod:nei/Widget");
    // Old-style ids: the sanitized folder, found through the normalized name; and the exact
    // tier resolves to the real on-disk case, which a zip needs.
    expect(facesOf(drafts.get("BuildCraft|Core") as LibraryDraft, "Gear").up).toBe(
      "buildcraftcore:blocks/gear",
    );
    expect(facesOf(drafts.get("Ztones") as LibraryDraft, "Korp").up).toBe("ztones:blocks/korp");
  });

  it("reads a namespace spread over several sources as one", async () => {
    const r = roster(
      ["bigmod:widget,200,true,BigMod,c,Widget"],
      ["bigmod:widget,200,0,false,Widget"],
    );
    const big = await source(
      { "bigmod/textures/blocks/widget.png": await tex(80, 180, 100) },
      "big.jar",
    );
    const patch = await source(
      { "bigmod/textures/blocks/gadget.png": await tex(20, 20, 230) },
      "patch.jar",
    );
    const { draft } = await run(r, [big, patch]);
    expect(facesOf(draft as LibraryDraft, "Widget").up).toBe("bigmod:blocks/widget");
  });

  it("falls back to vanilla's shared domain, still resolving per face", async () => {
    const r = roster(
      ["etfuturum:target,200,true,EtFuturum,c,Target"],
      ["etfuturum:target,200,0,false,Target"],
    );
    const mod = await source(
      { "etfuturum/textures/blocks/unrelated.png": await tex(200, 30, 30) },
      "et.jar",
    );
    const vanilla = await source(
      {
        "minecraft/textures/blocks/target_side.png": await tex(200, 30, 30),
        "minecraft/textures/blocks/target_top.png": await tex(230),
      },
      "mc.jar",
    );
    const { draft } = await run(r, [mod, vanilla]);
    const faces = facesOf(draft as LibraryDraft, "Target");
    expect(faces.up).toBe("minecraft:blocks/target_top");
    expect(faces.north).toBe("minecraft:blocks/target_side");
    expect(draft?.block("Target")?.variants?.[""]?.model).toBe("minecraft:nei/Target");
  });

  it("matches suffixes precisely", async () => {
    const r = roster(
      [
        "testmod:copper_block,200,true,TestMod,c,Block of Copper",
        "testmod:copper_barrel,201,true,TestMod,c,Copper Barrel",
        "testmod:tile.BlockController,202,true,TestMod,c,Controller",
        "testmod:tile.BlockCraftingStorage,203,true,TestMod,c,Crafting Storage",
      ],
      [
        "testmod:copper_block,200,0,false,Block of Copper",
        "testmod:copper_barrel,201,0,false,Copper Barrel",
        "testmod:tile.BlockController,202,0,false,Controller",
        "testmod:tile.BlockCraftingStorage,203,0,false,1k Crafting Storage",
        "testmod:tile.BlockCraftingStorage,203,1,false,4k Crafting Storage",
      ],
    );
    const t = "testmod/textures/blocks/";
    const src = await source({
      [`${t}copper_block.png`]: await tex(200, 100, 25),
      [`${t}copper_barrel_bottom.png`]: await tex(50),
      [`${t}copper_barrel_side.png`]: await tex(51),
      [`${t}copper_barrel_top.png`]: await tex(52),
      [`${t}BlockController.png`]: await tex(25, 125, 230),
      [`${t}BlockControllerColumn.png`]: await tex(230, 25, 25),
      [`${t}BlockControllerPowered.png`]: await tex(230, 25, 26),
      [`${t}BlockControllerInsideA.png`]: await tex(230, 25, 27),
      [`${t}BlockCraftingStorage.png`]: await tex(125, 125, 25),
      [`${t}BlockCraftingStorage4k.png`]: await tex(25, 230, 25),
    });
    const { result, draft } = await run(r, [src]);
    const d = draft as LibraryDraft;
    expect(facesOf(d, "Block of Copper").up).toBe("testmod:blocks/copper_block");
    expect(facesOf(d, "Copper Barrel").up).toBe("testmod:blocks/copper_barrel_top");
    expect(facesOf(d, "Copper Barrel").down).toBe("testmod:blocks/copper_barrel_bottom");
    expect(facesOf(d, "Controller").up).toBe("testmod:blocks/BlockController");
    expect(facesOf(d, "1k Crafting Storage").up).toBe("testmod:blocks/BlockCraftingStorage");
    expect(d.block("4k Crafting Storage")).toBeUndefined();
    expect(result.dropped.map((e) => e.display)).toEqual(["4k Crafting Storage"]);
  });

  it("drops an ambiguous entry and warns once per namespace with no assets", async () => {
    const r = roster(
      [
        "amb:thing,1,true,Amb,c,Thing",
        "ghost:one,2,true,Ghost,c,One",
        "ghost:two,3,true,Ghost,c,Two",
      ],
      ["amb:thing,1,0,false,Thing", "ghost:one,2,0,false,One", "ghost:two,3,0,false,Two"],
    );
    const src = await source({
      "amb/textures/blocks/thing.png": await tex(10),
      "amb/textures/blocks/thing_block.png": await tex(20),
    });
    const { result } = await run(r, [src]);
    expect(result.imported).toEqual([]);
    expect(result.droppedByMod).toEqual({ Amb: 1, Ghost: 2 });
    expect(result.warnings).toEqual([
      "no assets found for mod namespace: ghost (its blocks are dropped, not imported)",
      "no texture match, dropped: 1 block(s) in Amb",
      "no texture match, dropped: 2 block(s) in Ghost",
    ]);
  });

  it("finds a namespace by its mod label, and by the alias table", async () => {
    const r = roster(
      [
        "weird|id:thing,1,true,thingmod,c,Thing",
        "ProjRed|Core:stone,2,true,ProjectRed,c,Marble",
        "ExtraUtilities:cobblestone,3,true,Extra Utilities,c,Compressed",
      ],
      [
        "weird|id:thing,1,0,false,Thing",
        "ProjRed|Core:stone,2,0,false,Marble",
        "ExtraUtilities:cobblestone,3,0,false,Compressed",
      ],
    );
    const src = await source({
      "thingmod/textures/blocks/thing.png": await tex(10),
      "projectred/textures/blocks/stone.png": await tex(20),
      "extrautils/textures/blocks/cobblestone.png": await tex(30),
    });
    const { result } = await run(r, [src]);
    expect(result.imported.map((e) => e.name)).toEqual(["Compressed", "Marble", "Thing"]);
  });

  it("is idempotent: a re-import updates blocks in place and never makes copies", async () => {
    const r = roster(
      ["t:widget,100,true,T,c,Widget", "t:other,101,true,T,c,Widget"],
      ["t:widget,100,0,false,Widget", "t:other,101,0,false,Widget", "t:widget,100,0,false,Widget"],
    );
    const t = "t/textures/blocks/";
    const first = await source({
      [`${t}widget.png`]: await tex(10),
      [`${t}other.png`]: await tex(20),
    });
    const draft = new LibraryDraft("t");
    const a = await run(r, [first], { draft });
    // Same display name: the second gets a number; the duplicate row is the same block.
    expect(a.result.imported.map((e) => [e.registry, e.name, e.created])).toEqual([
      ["t:widget", "Widget", true],
      ["t:other", "Widget (2)", true],
      ["t:widget", "Widget", false],
    ]);
    expect(Object.keys(draft.blocks)).toEqual(["Widget", "Widget (2)"]);

    // Again, with the other's texture gone: it is left as it was (a re-import never deletes
    // working state). Textures are deduped by key, so widget keeps the pixels already read.
    const second = await source({ [`${t}widget.png`]: await tex(99) });
    const b = await run(r, [second], { draft });
    expect(Object.keys(draft.blocks)).toEqual(["Widget", "Widget (2)"]);
    expect(b.result.imported.map((e) => [e.registry, e.name, e.created])).toEqual([
      ["t:widget", "Widget", false],
      ["t:other", "Widget (2)", false],
      ["t:widget", "Widget", false],
    ]);
    expect(b.result.dropped).toEqual([]);
    expect(draft.block("Widget")?.color).toBe("#0a0a0a");
    expect(draft.block("Widget (2)")?.color).toBe("#141414");
  });

  it("imports a subset of mods and reports progress", async () => {
    const r = roster(
      ["a:x,1,true,A,c,X", "b:y,2,true,B,c,Y"],
      ["a:x,1,0,false,X", "b:y,2,0,false,Y"],
    );
    const src = await source({
      "a/textures/blocks/x.png": await tex(1),
      "b/textures/blocks/y.png": await tex(2),
    });
    const progress: [number, number, string][] = [];
    const drafts = new Map<string, LibraryDraft>();
    const result = await importRoster({
      roster: r,
      sources: [src],
      mods: ["B"],
      libraries: (ns) => {
        let d = drafts.get(ns);
        if (!d) {
          d = new LibraryDraft(ns);
          drafts.set(ns, d);
        }
        return d;
      },
      onProgress: (done, total, mod) => progress.push([done, total, mod]),
    });
    expect(result.imported.map((e) => e.name)).toEqual(["Y"]);
    expect([...drafts.keys()]).toEqual(["b"]);
    expect(progress.at(-1)).toEqual([1, 1, ""]);
  });

  it("stops when its signal aborts", async () => {
    const r = roster(["a:x,1,true,A,c,X"], ["a:x,1,0,false,X"]);
    const src = await source({ "a/textures/blocks/x.png": await tex(1) });
    await expect(
      importRoster({
        roster: r,
        sources: [src],
        libraries: (ns) => new LibraryDraft(ns),
        signal: { aborted: true },
      }),
    ).rejects.toThrow("cancelled");
  });

  it("writes a sorted manifest", async () => {
    const r = roster(
      ["t:b,1,true,T,c,B", "t:a,2,true,T,c,A", "t:none,3,true,T,c,None"],
      ["t:b,1,0,false,B", "t:a,2,1,false,A one", "t:a,2,0,false,A", "t:none,3,0,false,None"],
    );
    const src = await source({
      "t/textures/blocks/b.png": await tex(1),
      "t/textures/blocks/a_0.png": await tex(2),
      "t/textures/blocks/a_1.png": await tex(3),
    });
    const { result, drafts } = await run(r, [src]);
    const manifest = neiManifest(result, drafts.values());
    expect(manifest.mods.T?.ns).toBe("t");
    expect(manifest.mods.T?.imported.map((e) => [e.registry, e.meta])).toEqual([
      ["t:a", 0],
      ["t:a", 1],
      ["t:b", 0],
    ]);
    expect(manifest.mods.T?.imported[2]?.faces).toEqual({
      down: "t:blocks/b",
      up: "t:blocks/b",
      north: "t:blocks/b",
      south: "t:blocks/b",
      west: "t:blocks/b",
      east: "t:blocks/b",
    });
    expect(manifest.mods.T?.dropped).toEqual([{ registry: "t:none", meta: 0, display: "None" }]);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});
